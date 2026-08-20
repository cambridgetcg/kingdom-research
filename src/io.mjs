import { createHash } from 'node:crypto'
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const MAX_LOCAL_JSON_BYTES = 1024 * 1024

function normalized(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number')
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== 'object') throw new TypeError('unsupported JSON value')
  if (seen.has(value)) throw new TypeError('cyclic JSON value')
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => normalized(item, seen))
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError('JSON object must have the ordinary object prototype')
    }
    const result = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError('undefined JSON value')
      result[key] = normalized(value[key], seen)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

export function canonicalJson(value) {
  return JSON.stringify(normalized(value))
}

export function prettyCanonicalJson(value) {
  return `${JSON.stringify(normalized(value), null, 2)}\n`
}

export function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function sha256Json(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value)))
}

export function readBoundedBytes(path, maximum = MAX_LOCAL_JSON_BYTES) {
  const absolute = resolve(path)
  if (!insideRoot(absolute)) throw new RangeError('bundled input must remain inside the repository')
  assertNoSymlinkComponents(absolute)
  const size = statSync(path).size
  if (size < 1 || size > maximum) throw new RangeError(`file size outside 1..${maximum} bytes`)
  return readFileSync(path)
}

export function readExternalBoundedBytes(path, maximum = MAX_LOCAL_JSON_BYTES) {
  const absolute = resolve(path)
  const status = lstatSync(absolute)
  if (status.isSymbolicLink() || !status.isFile()) throw new TypeError('external input must be one regular non-symlink file')
  if (status.size < 1 || status.size > maximum) throw new RangeError(`file size outside 1..${maximum} bytes`)
  return readFileSync(absolute)
}

function scanStrictJson(text) {
  let position = 0

  const fail = (message) => { throw new SyntaxError(`${message} at character ${position}`) }
  const whitespace = () => {
    while (position < text.length && /[ \t\r\n]/u.test(text[position])) position += 1
  }
  const stringToken = () => {
    if (text[position] !== '"') fail('expected JSON string')
    const start = position
    position += 1
    while (position < text.length) {
      const character = text[position]
      if (character === '"') {
        position += 1
        return JSON.parse(text.slice(start, position))
      }
      if (character === '\\') {
        position += 1
        if (position >= text.length) fail('unterminated JSON escape')
        if (text[position] === 'u') position += 4
      } else if (character.codePointAt(0) < 0x20) {
        fail('control character in JSON string')
      }
      position += 1
    }
    fail('unterminated JSON string')
  }
  const value = (depth) => {
    if (depth > 128) fail('JSON nesting exceeds 128')
    whitespace()
    const character = text[position]
    if (character === '{') return object(depth + 1)
    if (character === '[') return array(depth + 1)
    if (character === '"') { stringToken(); return }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, position)) { position += literal.length; return }
    }
    const number = text.slice(position).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0]
    if (number !== undefined) { position += number.length; return }
    fail('invalid JSON value')
  }
  const array = (depth) => {
    position += 1
    whitespace()
    if (text[position] === ']') { position += 1; return }
    while (true) {
      value(depth)
      whitespace()
      if (text[position] === ']') { position += 1; return }
      if (text[position] !== ',') fail('expected comma or closing bracket')
      position += 1
    }
  }
  const object = (depth) => {
    position += 1
    whitespace()
    if (text[position] === '}') { position += 1; return }
    const keys = new Set()
    while (true) {
      whitespace()
      const key = stringToken()
      if (keys.has(key)) fail(`duplicate JSON object key ${JSON.stringify(key)}`)
      keys.add(key)
      whitespace()
      if (text[position] !== ':') fail('expected colon')
      position += 1
      value(depth)
      whitespace()
      if (text[position] === '}') { position += 1; return }
      if (text[position] !== ',') fail('expected comma or closing brace')
      position += 1
    }
  }

  whitespace()
  value(0)
  whitespace()
  if (position !== text.length) fail('trailing data after JSON value')
}

export function parseJsonBytes(bytes, label = 'JSON') {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  scanStrictJson(text)
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${label} must contain an object or array`)
  }
  return value
}

export function readJson(path, maximum = MAX_LOCAL_JSON_BYTES) {
  return parseJsonBytes(readBoundedBytes(path, maximum), path)
}

export function insideRoot(path) {
  const absolute = resolve(path)
  const rel = relative(ROOT, absolute)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.includes(`${sep}..${sep}`)
}

function assertNoSymlinkComponents(path) {
  const absolute = resolve(path)
  if (!insideRoot(absolute)) throw new RangeError('path must be inside the repository')
  const rootStat = lstatSync(ROOT)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new TypeError('repository root must be a real directory')
  let current = ROOT
  for (const component of relative(ROOT, absolute).split(sep)) {
    current = join(current, component)
    try {
      const status = lstatSync(current)
      if (status.isSymbolicLink()) throw new TypeError('writer refuses symbolic-link path components')
      if (current !== absolute && !status.isDirectory()) throw new TypeError('writer ancestor must be a directory')
    } catch (error) {
      if (error?.code === 'ENOENT') break
      throw error
    }
  }
}

export function atomicWriteInsideRoot(path, text) {
  const absolute = resolve(path)
  if (!insideRoot(absolute)) throw new RangeError('output must be a file inside the repository')
  assertNoSymlinkComponents(absolute)
  mkdirSync(dirname(absolute), { recursive: true })
  assertNoSymlinkComponents(absolute)
  const temporary = `${absolute}.${process.pid}.tmp`
  assertNoSymlinkComponents(temporary)
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeSync(descriptor, text, undefined, 'utf8')
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, absolute)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

export function appendOnlyWriteInsideRoot(path, text) {
  const absolute = resolve(path)
  if (!insideRoot(absolute)) throw new RangeError('capture must be inside the repository')
  assertNoSymlinkComponents(absolute)
  mkdirSync(dirname(absolute), { recursive: true })
  assertNoSymlinkComponents(absolute)
  let descriptor
  try {
    descriptor = openSync(absolute, 'wx', 0o600)
    writeSync(descriptor, text, undefined, 'utf8')
    closeSync(descriptor)
    descriptor = undefined
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}
