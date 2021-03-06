'use strict'
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const util = require('util')
const stream = require('stream')
const os = require('os')

const statTimeKeys = ['atime', 'mtime', 'ctime', 'birthtime']
const methodsName = ['isFile', 'isDirectory', 'isBlockDevice',
'isCharacterDevice', 'isSymbolicLink', 'isFIFO', 'isSocket']

// Because process.dlopen (https://github.com/nodejs/node/blob/v6.x/lib/module.js#L583) only takes
// a real file path as its second parameter, so we need to create a tmp dir
// to put the .node files and remove them when node.js process exits.
const addonsDir = path.join(os.tmpdir(), `${Date.now()}-lockjs-addons`)

;(function () {
  let project = []

  let publicKey = process.argv[1]
  for (let i = 2; i <= 6; i++) {
    if (process.argv[i]) project.push(new Buffer(process.argv[i]))
    else break
  }

  project = Buffer.concat(project)

  let pos = 0
  let filesMap = new Map()
  let requireCache = new Map()
  let entryPoint

  // encrypted key length
  let encryptedKeyLength = new Buffer(20)
  if (project.copy(encryptedKeyLength, 0, pos, pos += 20) !== 20) {
    throw new Error('unable to read encrypted key length.')
  }
  encryptedKeyLength = getDecrypedLength(encryptedKeyLength)

  // encrypted key
  let encryptedKey = new Buffer(encryptedKeyLength)
  if (project.copy(encryptedKey, 0, pos, pos += encryptedKeyLength) !== encryptedKeyLength) {
    throw new Error('unable to read encrypted key.')
  }
  encryptedKey = encryptedKey.toString()

  let privateKey = decrypt(encryptedKey, publicKey)
  let key = `${publicKey}${privateKey}`

  // entry point length
  let entryPointLength = new Buffer(20)
  if (project.copy(entryPointLength, 0, pos, pos += 20) !== 20) {
    throw new Error('unable to read entry point length.')
  }
  entryPointLength = getDecrypedLength(entryPointLength)

  // entry point
  entryPoint = new Buffer(entryPointLength)
  if (project.copy(entryPoint, 0, pos, pos += entryPointLength) !== entryPointLength) {
    throw new Error('unable to read entry point.')
  }
  entryPoint = decrypt(entryPoint, key)

  // file header length
  let filesHeaderLength = new Buffer(20)
  if (project.copy(filesHeaderLength, 0, pos, pos += 20) !== 20) {
    throw new Error('unable to read file header length.')
  }
  filesHeaderLength = getDecrypedLength(filesHeaderLength)

  // file header
  let fileHeader = new Buffer(filesHeaderLength)
  if (project.copy(fileHeader, 0, pos, pos += filesHeaderLength) !== filesHeaderLength) {
    throw new Error('unable to read file header.')
  }
  fileHeader = JSON.parse(decrypt(fileHeader, key))

  Object.keys(fileHeader).forEach(function (filePath) {
    let meta = fileHeader[filePath]
    let fileBuffer = new Buffer(meta.size)
    let readSize = project.copy(fileBuffer, 0, pos + meta.offset, pos + meta.offset + meta.size)
    if (readSize !== meta.size) throw new Error(`unable to unlock ${filePath}.`)

    let content
    if (!meta.stat.isFile) content = null
    else if (meta.stat.isBinary) content = new Buffer(fileBuffer.toString(), 'hex')
    else content = decrypt(fileBuffer, key)

    filesMap.set(path.resolve(process.cwd(), filePath), {
      stat: formatStat(meta.stat),
      content
    })
  })

  // Monkey patch require.extensions['.js']
  let originalRequireJS = require.extensions['.js']

  require.extensions['.js'] = function (module, filename) {
    if (!filesMap.has(filename)) {
      return originalRequireJS.call(require.extensions, module, filename)
    }

    let content = filesMap.get(filename).content

    return module._compile(stripBOM(content), filename)
  }

  // Monkey patch require.extensions['.json']
  let originalRequireJSON = require.extensions['.json']

  require.extensions['.json'] = function (module, filename) {
    if (!filesMap.has(filename)) {
      return originalRequireJSON.call(require.extensions, module, filename)
    }

    let content = filesMap.get(filename).content

    try {
      module.exports = JSON.parse(stripBOM(content))
    } catch (err) {
      err.message = `${filename}:${err.message}`
      throw err
    }
  }

  // Monkey patch require.extensions['.node']
  process.on('exit', (code) => cleanup(null, code))
  process.on('SIGINT', () => cleanup(null, 130))
  process.on('uncaughtException', (err) => cleanup(err))

  let originalRequireNode = require.extensions['.node']

  require.extensions['.node'] = function (module, filename) {
    if (!filesMap.has(filename)) {
      return originalRequireNode.call(require.extensions, module, filename)
    }

    if (!fs.existsSync(addonsDir)) fs.mkdirSync(addonsDir)

    let addon = path.join(addonsDir, path.basename(filename))
    fs.writeFileSync(addon, filesMap.get(filename).content)

    return process.dlopen(module, path._makeLong(addon))
  }

  // Monkey patch Module._findPath
  let _findPath = Object.getPrototypeOf(module).constructor._findPath

  Object.getPrototypeOf(module).constructor._findPath = function (request, paths, isMain) {
    let cacheKey = JSON.stringify({ request, paths })
    if (requireCache.has(cacheKey)) return requireCache.get(cacheKey)

    for (let p of paths) {
      const trailingSlash = request.length > 0 && request.charCodeAt(request.length - 1) === 47
      let tryPath = path.resolve(p, request)
      let pkgResult, extsResult, indexsResult

      if (!trailingSlash) {
        if (filesMap.has(tryPath) && filesMap.get(tryPath).stat.isFile()) {
          requireCache.set(cacheKey, tryPath)
          return tryPath
        } else if (filesMap.has(tryPath) && filesMap.get(tryPath).stat.isDirectory()) {
          pkgResult = tryPackage(tryPath, filesMap)

          if (pkgResult) {
            requireCache.set(cacheKey, pkgResult)
            return pkgResult
          }
        }

        extsResult = tryExtensions(tryPath, filesMap)
        if (extsResult) {
          requireCache.set(cacheKey, extsResult)
          return extsResult
        }
      }

      pkgResult = tryPackage(tryPath, filesMap)

      if (pkgResult) {
        requireCache.set(cacheKey, pkgResult)
        return pkgResult
      }

      indexsResult = tryIndex(tryPath, filesMap)
      if (indexsResult) {
        requireCache.set(cacheKey, indexsResult)
        return indexsResult
      }
    }

    return _findPath.call(Object.getPrototypeOf(module).constructor, request, paths, isMain)
  }

  // Monkey pactch fs.readFile & fs.readFileSync
  let originalReadFileSync = fs.readFileSync

  Object.defineProperty(fs, 'readFileSync', { get: function () {
    return function (_path, options) {
      if (!options) {
        options = { encoding: null, flag: 'r' }
      } else if (typeof options === 'string') {
        options = { encoding: options, flag: 'r' }
      } else if (typeof options !== 'object') {
        throwOptionsError(options)
      }

      let encoding = options.encoding
      assertEncoding(encoding)

      let virtualPath = generateVirtualPath(_path)

      if (!filesMap.has(virtualPath)) return originalReadFileSync.call(fs, _path, options)

      let buffer = new Buffer(filesMap.get(virtualPath).content)

      if (!encoding) return buffer

      return buffer.toString(encoding)
    } }
  })

  let originalReadFile = fs.readFile

  Object.defineProperty(fs, 'readFile', { get: function () {
    return function (_path, options, callback) {
      if (!options) {
        options = { encoding: null, flag: 'r' }
      } else if (typeof options === 'string') {
        options = { encoding: options, flag: 'r' }
      } else if (typeof options !== 'object') {
        throwOptionsError(options)
      }

      let encoding = options.encoding
      assertEncoding(encoding)

      let virtualPath = generateVirtualPath(_path)

      if (!filesMap.has(virtualPath)) return originalReadFile.call(fs, _path, options, callback)

      let buffer = new Buffer(filesMap.get(virtualPath).content)

      if (!encoding) return process.nextTick(callback, null, buffer)

      return process.nextTick(callback, null, buffer.toString(encoding))
    } }
  })

  // Monkey pactch fs.readdir & fs.readdirSync
  let originalReaddir = fs.readdir

  Object.defineProperty(fs, 'readdir', { get: function () {
    return function (_path, options, callback) {
      options = options || {}
      if (typeof options === 'string') options = {encoding: options}
      if (typeof options !== 'object') throw new TypeError('options must be a string or an object')

      let virtualPath = generateVirtualPath(_path)

      let keysWithPrefix = getHavePrefixKeys(filesMap, virtualPath)

      if (!keysWithPrefix.length) return originalReaddir.call(fs, _path, options, callback)

      process.nextTick(callback, null, keysWithPrefix
        .filter((key) => key[virtualPath.length] === '/')
        .map((key) => {
          key = key.slice(virtualPath.length + 1)
          let i = key.indexOf('/')
          if (!~i) return key
          else return key.slice(0, i)
        })
      )
    } }
  })

  let originalReaddirSync = fs.readdirSync

  Object.defineProperty(fs, 'readdirSync', { get: function () {
    return function (_path, options) {
      options = options || {}
      if (typeof options === 'string') options = {encoding: options}
      if (typeof options !== 'object') throw new TypeError('options must be a string or an object')

      let virtualPath = generateVirtualPath(_path)

      let keysWithPrefix = getHavePrefixKeys(filesMap, virtualPath)

      if (!keysWithPrefix.length) return originalReaddirSync.call(fs, _path, options)

      return keysWithPrefix
        .filter((key) => key[virtualPath.length] === '/')
        .map((key) => {
          key = key.slice(virtualPath.length + 1)
          let i = key.indexOf('/')
          if (!~i) return key
          else return key.slice(0, i)
        })
    } }
  })

  // Monkey pactch fs.stat & fs.statSync
  let originalStat = fs.stat

  Object.defineProperty(fs, 'stat', { get: function () {
    return function (_path, callback) {
      let virtualPath = generateVirtualPath(_path)

      if (!filesMap.has(virtualPath)) return originalStat.call(fs, _path, callback)

      return process.nextTick(callback, null, filesMap.get(virtualPath).stat)
    } }
  })

  let originalStatSync = fs.statSync

  Object.defineProperty(fs, 'statSync', { get: function () {
    return function (_path) {
      let virtualPath = generateVirtualPath(_path)

      if (!filesMap.has(virtualPath)) return originalStatSync.call(fs, _path)

      return filesMap.get(virtualPath).stat
    } }
  })

  // Monkey patch fs.lstat && fs.lstatSync
  let originalLstat = fs.lstat

  Object.defineProperty(fs, 'lstat', { get: function () {
    return function (_path, callback) {
      let virtualPath = generateVirtualPath(_path)

      if (!filesMap.has(virtualPath)) return originalLstat.call(fs, _path, callback)

      return process.nextTick(callback, null, filesMap.get(virtualPath).stat)
    } }
  })

  let originalLstatSync = fs.lstatSync

  Object.defineProperty(fs, 'lstatSync', { get: function () {
    return function (_path) {
      let virtualPath = generateVirtualPath(_path)

      if (!filesMap.has(virtualPath)) return originalLstatSync.call(fs, _path)

      return filesMap.get(virtualPath).stat
    } }
  })

  // Monkey patch fs.exists && fs.existsSync
  let originalExists = fs.exists

  Object.defineProperty(fs, 'exists', { get: function () {
    return function (_path, callback) {
      let virtualPath = generateVirtualPath(_path)

      if (filesMap.has(virtualPath)) return process.nextTick(callback, null, true)

      return originalExists(_path, callback)
    } }
  })

  let originalExistsSync = fs.existsSync

  Object.defineProperty(fs, 'existsSync', { get: function () {
    return function (_path) {
      let virtualPath = generateVirtualPath(_path)

      if (filesMap.has(virtualPath)) return true

      return originalExistsSync(_path)
    } }
  })

  // Monkey patch fs.createReadStream
  util.inherits(ReadStream, stream.Readable)

  function ReadStream (_path, options) {
    if (!(this instanceof ReadStream)) return new ReadStream(_path, options)

    if (options === undefined) options = {}
    else if (typeof options === 'string') options = { encoding: options }
    else if (options === null || typeof options !== 'object') {
      throw new TypeError('options argument must be a string or an object')
    }

    options = Object.create(options)
    if (options.highWaterMark === undefined) options.highWaterMark = 64 * 1024

    stream.Readable.call(this, options)
    this.path = _path
    this.options = options
    this.start = options.start || 0
    this.end = options.end || Buffer.byteLength(filesMap.get(_path).content) - 1
    this.bytesRead = 0
    this.pos = 0

    if (this.start !== undefined) {
      if (typeof this.start !== 'number') throw new TypeError('start option must be a Number')

      if (typeof this.end !== 'number') throw new TypeError('end option must be a Number')

      if (this.start > this.end) throw new Error('start option must be <= end option')

      this.pos = this.start
    }

    Buffer.isBuffer(filesMap.get(_path).content)
      ? this.buf = filesMap.get(_path).content.slice(this.start, this.end + 1)
      : this.buf = new Buffer(filesMap.get(_path).content).slice(this.start, this.end + 1)
  }

  ReadStream.prototype._read = function (n) {
    if (this.destroyed) return

    if (this.pos >= this.end) return this.push(null)
    this.push(this.buf.slice(this.pos, this.pos += this._readableState.highWaterMark))
  }

  let originalCreateReadStream = fs.createReadStream

  Object.defineProperty(fs, 'createReadStream', { get: function () {
    return function (_path, options) {
      let virtualPath = generateVirtualPath(_path)

      if (!filesMap.has(virtualPath)) return originalCreateReadStream.call(fs, _path, options)

      return new ReadStream(_path, options)
    } }
  })

  Object.getPrototypeOf(module).constructor._load(path.resolve(process.cwd(), entryPoint), null, true)
})()

function tryExtensions (tryPath, filesMap) {
  let exts = ['.js', '.json', '.node']
  for (let ext of exts) {
    let fullPath = `${tryPath}${ext}`
    if (filesMap.has(fullPath) && filesMap.get(fullPath).stat.isFile()) return fullPath
  }

  return false
}

function tryIndex (tryPath, filesMap) {
  if (!tryPath) return false

  let indexs = ['index.js', 'index.json', 'index.node']
  if (tryPath.endsWith('/')) tryPath = tryPath.slice(0, -1)

  for (let index of indexs) {
    let fullPath = `${tryPath}/${index}`
    if (filesMap.has(fullPath) && filesMap.get(fullPath).stat.isFile()) return fullPath
  }

  return false
}

function tryPackage (tryPath, filesMap) {
  let main
  let pkgPath = `${tryPath}/package.json`
  if (filesMap.has(pkgPath) && filesMap.get(pkgPath).stat.isFile()) {
    main = JSON.parse(filesMap.get(pkgPath).content).main
    if (!main) return false
    main = path.resolve(tryPath, main)
    if (filesMap.has(main)) return main
  }

  let extsResult = tryExtensions(main, filesMap)
  if (extsResult) return extsResult

  let indexsResult = tryIndex(main, filesMap)
  if (indexsResult) return indexsResult

  return false
}

function getDecrypedLength (decrypted) {
  decrypted = decrypted.toString()
  return Number(decrypted.slice(decrypted.lastIndexOf('$') + 1))
}

function decrypt (content, key) {
  if (typeof content !== 'string') content = content.toString()

  let decrypted = ''
  let dip = crypto.createDecipher('rc4', key)
  decrypted += dip.update(content, 'hex')
  decrypted += dip.final()

  return decrypted
}

function stripBOM (content) {
  return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content
}

function getHavePrefixKeys (map, prefix) {
  return Array.from(map.keys()).filter((key) => String(key).startsWith(prefix))
}

function removeTrailingSlash (_path) {
  if (_path.endsWith('/')) _path = _path.slice(0, _path.length - 1)

  return _path
}

function throwOptionsError (options) {
  throw new TypeError(`Expected options to be either an object or a string, but got ${typeof options} instead`)
}

function assertEncoding (encoding) {
  if (encoding && !Buffer.isEncoding(encoding)) {
    throw new Error('Unknown encoding: ' + encoding)
  }
}

function cleanup (err, code) {
  if (err) console.error(err.stack)

  if (fs.existsSync(addonsDir)) {
    fs.readdirSync(addonsDir).forEach(function (addon) {
      let curPath = `${addonsDir}/${addon}`
      if (fs.statSync(curPath).isDirectory()) cleanup(curPath)
      else fs.unlinkSync(curPath)
    })
    fs.rmdirSync(addonsDir)
  }

  process.exit(err ? 1 : code)
}

function formatStat (stat) {
  for (let timeKey of statTimeKeys) stat[timeKey] = new Date(stat[timeKey])

  for (let method of methodsName) {
    let result = stat[method]
    stat[method] = function () { return result }
  }

  return stat
}

function generateVirtualPath (_path) {
  _path = removeTrailingSlash(_path)

  if (path.isAbsolute(_path)) return path.resolve(_path)
  return path.resolve(process.cwd(), _path)
}
