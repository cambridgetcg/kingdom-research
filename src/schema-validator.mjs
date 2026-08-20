import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { ROOT, canonicalJson, readJson } from './io.mjs'

const SCHEMA_DIR = join(ROOT, 'schemas', 'v0.1')
const MAX_DEPTH = 64

function jsonEqual(left, right) {
  try { return canonicalJson(left) === canonicalJson(right) } catch { return false }
}

function typeMatches(value, type) {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (type === 'integer') return Number.isSafeInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

function pointer(root, fragment) {
  if (fragment === '' || fragment === '#') return root
  if (!fragment.startsWith('#/')) throw new Error(`unsupported schema fragment ${fragment}`)
  let current = root
  for (const raw of fragment.slice(2).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, token)) {
      throw new Error(`unresolved schema fragment ${fragment}`)
    }
    current = current[token]
  }
  return current
}

export function loadSchemaRegistry() {
  const registry = new Map()
  for (const name of readdirSync(SCHEMA_DIR).filter((entry) => entry.endsWith('.json')).sort()) {
    const schema = readJson(join(SCHEMA_DIR, name))
    registry.set(name, schema)
    if (typeof schema.$id === 'string') registry.set(schema.$id, schema)
  }
  return registry
}

function resolveReference(reference, rootSchema, registry) {
  const hash = reference.indexOf('#')
  const document = hash === -1 ? reference : reference.slice(0, hash)
  const fragment = hash === -1 ? '' : reference.slice(hash)
  const targetRoot = document === ''
    ? rootSchema
    : registry.get(document) ?? registry.get(basename(document))
  if (targetRoot === undefined) throw new Error(`unresolved schema reference ${reference}`)
  return { schema: pointer(targetRoot, fragment), root: targetRoot }
}

function walk(value, schema, path, rootSchema, registry, depth) {
  if (depth > MAX_DEPTH) return [`${path}: schema nesting exceeds ${MAX_DEPTH}`]
  if (schema === true) return []
  if (schema === false) return [`${path}: value is forbidden`]
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return [`${path}: invalid schema node`]
  }
  if (typeof schema.$ref === 'string') {
    const resolved = resolveReference(schema.$ref, rootSchema, registry)
    return walk(value, resolved.schema, path, resolved.root, registry, depth + 1)
  }

  const issues = []
  if (Object.hasOwn(schema, 'const') && !jsonEqual(value, schema.const)) {
    issues.push(`${path}: must equal declared constant`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => jsonEqual(item, value))) {
    issues.push(`${path}: value is outside enum`)
  }
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.map((branch) => walk(value, branch, path, rootSchema, registry, depth + 1))
    if (branches.filter((branch) => branch.length === 0).length !== 1) {
      issues.push(`${path}: must match exactly one oneOf branch`)
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) issues.push(...walk(value, child, path, rootSchema, registry, depth + 1))
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => typeMatches(value, type))) {
      issues.push(`${path}: expected ${types.join('|')}`)
      return issues
    }
  }

  if (typeof value === 'string') {
    const length = [...value].length
    if (schema.minLength !== undefined && length < schema.minLength) issues.push(`${path}: string is too short`)
    if (schema.maxLength !== undefined && length > schema.maxLength) issues.push(`${path}: string is too long`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      issues.push(`${path}: string does not match pattern`)
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${path}: number is below minimum`)
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${path}: number is above maximum`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${path}: array has too few items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${path}: array has too many items`)
    if (schema.uniqueItems === true) {
      const keys = value.map((item) => canonicalJson(item))
      if (new Set(keys).size !== keys.length) issues.push(`${path}: array items must be unique`)
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        issues.push(...walk(value[index], schema.items, `${path}/${index}`, rootSchema, registry, depth + 1))
      }
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {}
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) issues.push(`${path}/${required}: required property is missing`)
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        issues.push(...walk(child, properties[key], `${path}/${key}`, rootSchema, registry, depth + 1))
      } else if (schema.additionalProperties === false) {
        issues.push(`${path}/${key}: additional property is forbidden`)
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        issues.push(...walk(child, schema.additionalProperties, `${path}/${key}`, rootSchema, registry, depth + 1))
      }
    }
  }
  return issues
}

export function validateWithSchema(value, schemaName, registry = loadSchemaRegistry()) {
  const schema = registry.get(schemaName)
  if (schema === undefined) throw new Error(`unknown schema ${schemaName}`)
  return walk(value, schema, '$', schema, registry, 0)
}

function collectReferences(value, references = []) {
  if (value === null || typeof value !== 'object') return references
  if (typeof value.$ref === 'string') references.push(value.$ref)
  for (const child of Object.values(value)) collectReferences(child, references)
  return references
}

export function schemaDocumentIssues(registry = loadSchemaRegistry()) {
  const issues = []
  const seenIds = new Set()
  for (const [name, schema] of registry) {
    if (!name.endsWith('.json') || name !== basename(name)) continue
    if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
      issues.push(`${name}: unsupported or missing $schema`)
    }
    if (typeof schema.$id !== 'string' || seenIds.has(schema.$id)) {
      issues.push(`${name}: missing or duplicate $id`)
    } else {
      seenIds.add(schema.$id)
    }
    for (const reference of collectReferences(schema)) {
      try { resolveReference(reference, schema, registry) } catch (error) {
        issues.push(`${name}: ${error.message}`)
      }
    }
  }
  return issues.sort()
}
