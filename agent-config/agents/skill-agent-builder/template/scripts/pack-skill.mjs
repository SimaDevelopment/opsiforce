#!/usr/bin/env node
/**
 * Turn a skill directory into the bodies the platform accepts:
 *
 *   node pack-skill.mjs --json scratch/<name> --name <name>   the body POST /skills wants
 *   node pack-skill.mjs --json scratch/<name>                  the body POST /skills/<id>/versions wants
 *
 * It does not validate — run validate-skill.mjs first.
 *
 * `--skill` writes its zip by hand because the platform's own packer needs `archiver`, which this pod has
 * no node_modules for; the round-trip through the platform's unpacker is a test.
 */
import { deflateRawSync } from "node:zlib"
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

function readSkillDirectory(directory) {
  const walk = (absolute, prefix) => {
    const found = []
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, entry.name)
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        found.push(...walk(child, path))
        continue
      }
      found.push({ path, content: readFileSync(child), executable: (lstatSync(child).mode & 0o111) !== 0 })
    }
    return found
  }
  // Codepoint order, so the same tree always produces the same bytes and the same file order.
  return walk(directory, "").toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function isTextFile(content) {
  return !content.subarray(0, 8192).includes(0)
}

function toApiFiles(tree) {
  return tree.map((file) => {
    const text = isTextFile(file.content)
    return {
      path: file.path,
      content: text ? file.content.toString("utf8") : file.content.toString("base64"),
      ...(text ? {} : { isBinary: true }),
      ...(file.executable ? { executable: true } : {}),
    }
  })
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]
  return (crc ^ -1) >>> 0
}

/**
 * A minimal deterministic zip writer: one deflated entry per file, mode bits in the external
 * attributes so the platform's unpacker sees the executable bit, and a fixed DOS timestamp so the
 * same tree always packs to the same bytes.
 */
function packSkill(tree) {
  const chunks = []
  const central = []
  let offset = 0

  for (const file of tree) {
    const name = Buffer.from(file.path, "utf8")
    const deflated = deflateRawSync(file.content, { level: 9 })
    const crc = crc32(file.content)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(deflated.length, 18)
    local.writeUInt32LE(file.content.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, deflated)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(0x031e, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(8, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt16LE(0x21, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(deflated.length, 20)
    header.writeUInt32LE(file.content.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(((file.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38)
    header.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([header, name]))

    offset += local.length + name.length + deflated.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(tree.length, 8)
  end.writeUInt16LE(tree.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, end])
}

function main(argv) {
  const args = argv.slice(2)
  const mode = args.includes("--skill") ? "skill" : "json"
  const nameIndex = args.indexOf("--name")
  const name = nameIndex === -1 ? null : args[nameIndex + 1]
  const displayIndex = args.indexOf("--display-name")
  const displayName = displayIndex === -1 ? null : args[displayIndex + 1]
  const positional = args.filter((arg, index) => !arg.startsWith("--") && index - 1 !== nameIndex && index - 1 !== displayIndex)
  const directory = positional[0]
  if (!directory) {
    console.error(
      "usage: pack-skill.mjs --json <skill-directory> [--name <name>] [--display-name <name>]"
    )
    return 2
  }

  const tree = readSkillDirectory(directory)
  if (mode === "json") {
    // `name` is required by POST /skills and refused by POST /skills/{id}/versions, so it is opt-in.
    console.log(
      JSON.stringify({
        ...(name ? { name } : {}),
        ...(displayName ? { displayName } : {}),
        files: toApiFiles(tree),
      })
    )
    return 0
  }

  const out = join(positional[1] ?? ".", `${basename(directory)}.skill`)
  writeFileSync(out, packSkill(tree))
  console.log(out)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv))
}
