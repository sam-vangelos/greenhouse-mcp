import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import yauzl from "yauzl";
import { crc32, createInflate } from "node:zlib";

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_PDF_STREAMS = 1_000;
const MAX_PDF_STREAM_BYTES = 20 * 1024 * 1024;
const MAX_PDF_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_PDF_DICTIONARY_BYTES = 64 * 1024;
const MAX_PDF_IMAGE_PIXELS = 1_000_000;
const MAX_DOCX_ENTRIES = 1_000;
const MAX_DOCX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_DOCX_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_DOCX_EXPANSION_RATIO = 500;
const ALLOWED_ZIP_COMPRESSION_METHODS = new Set([0, 8]);
const ALLOWED_PARSER_ENV_KEYS = new Set(["NODE_ENV", "__CF_USER_TEXT_ENCODING"]);

class SafeParserError extends Error {
  constructor(errorClass) {
    super(errorClass);
    this.name = "SafeParserError";
    this.errorClass = errorClass;
  }
}

async function main() {
  if (process.env.NODE_ENV !== "production" || Object.keys(process.env).some((key) => !ALLOWED_PARSER_ENV_KEYS.has(key))) {
    throw new SafeParserError("suspicious");
  }
  const format = process.argv[2];
  const maxOutputBytes = Number.parseInt(process.argv[3] ?? "", 10);
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new SafeParserError("malformed");
  }
  const bytes = await readInput();

  let text;
  if (format === "pdf") {
    text = await extractPdf(bytes);
  } else if (format === "docx") {
    await validateDocxArchive(bytes);
    const result = await mammoth.extractRawText({ buffer: bytes });
    text = result.value;
  } else if (format === "text") {
    text = extractPlainText(bytes);
  } else {
    throw new SafeParserError("unsupported_type");
  }

  if (typeof text !== "string" || text.includes("\0") || text.trim().length === 0) {
    throw new SafeParserError("no_extractable_text");
  }
  const bounded = boundUtf8(text, maxOutputBytes);
  await writeResult({
    ok: true,
    text: bounded.text,
    extractedBytes: bounded.originalBytes,
    outputTruncated: bounded.truncated,
  });
}

async function extractPdf(bytes) {
  let parser;
  try {
    await validatePdfStreams(bytes);
    parser = new PDFParse({
      data: bytes,
      stopAtErrors: true,
      isEvalSupported: false,
      useWorkerFetch: false,
      useSystemFonts: false,
      enableXfa: false,
      maxImageSize: 1_000_000,
      verbosity: 0,
    });
    const result = await parser.getText();
    return result.text;
  } catch (error) {
    if (error instanceof SafeParserError) throw error;
    const message = error instanceof Error ? `${error.name} ${error.message}` : "";
    if (/password|encrypted/i.test(message)) {
      throw new SafeParserError("encrypted");
    }
    throw new SafeParserError("malformed");
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}

async function validatePdfStreams(bytes) {
  let cursor = 0;
  let lastToken;
  let lastDictionary;
  let expandedBytes = 0;
  let streams = 0;
  const dictionaryStarts = [];
  while (cursor < bytes.length) {
    const token = nextPdfToken(bytes, cursor);
    if (!token) break;
    cursor = token.end;
    if (token.type === "dictStart") {
      dictionaryStarts.push(token.start);
    } else if (token.type === "dictEnd") {
      const start = dictionaryStarts.pop();
      if (start === undefined) throw new SafeParserError("malformed");
      lastDictionary = { start, end: token.end };
    } else if (token.type === "word" && token.value === "stream") {
      if (lastToken?.type !== "dictEnd" || !lastDictionary) {
        throw new SafeParserError("suspicious");
      }
      const dataStart = pdfStreamDataStart(bytes, token.end);
      const settings = readPdfStreamSettings(bytes, lastDictionary.start, lastDictionary.end);
      streams += 1;
      if (streams > MAX_PDF_STREAMS) throw new SafeParserError("size_limit");
      const remaining = MAX_PDF_EXPANDED_BYTES - expandedBytes;
      let dataEnd;
      let endstream;
      let streamBytes;
      if (settings.length === undefined) {
        const located = await findIndirectPdfStream(bytes, dataStart, settings.filters, remaining);
        dataEnd = located.dataEnd;
        endstream = located.endstream;
        streamBytes = located.expandedBytes;
      } else {
        dataEnd = dataStart + settings.length;
        if (!Number.isSafeInteger(dataEnd) || dataEnd > bytes.length) throw new SafeParserError("malformed");
        endstream = nextPdfToken(bytes, dataEnd);
        if (!endstream || endstream.type !== "word" || endstream.value !== "endstream") {
          if (settings.filters.length > 0) throw new SafeParserError("malformed");
          endstream = findPdfEndstream(bytes, dataStart);
          if (!endstream) throw new SafeParserError("malformed");
          dataEnd = pdfStreamPayloadEnd(bytes, endstream.start);
        }
        streamBytes = await measurePdfStream(bytes.subarray(dataStart, dataEnd), settings.filters, remaining);
      }
      expandedBytes += streamBytes;
      cursor = endstream.end;
      lastDictionary = undefined;
      lastToken = endstream;
      continue;
    }
    lastToken = token;
  }
  if (dictionaryStarts.length !== 0) throw new SafeParserError("malformed");
}

async function findIndirectPdfStream(bytes, dataStart, filters, remaining) {
  let searchFrom = dataStart;
  for (let candidate = 0; candidate < 32; candidate += 1) {
    const endstream = findPdfEndstream(bytes, searchFrom);
    if (!endstream) break;
    const dataEnd = pdfStreamPayloadEnd(bytes, endstream.start);
    try {
      const expandedBytes = await measurePdfStream(bytes.subarray(dataStart, dataEnd), filters, remaining);
      return { dataEnd, endstream, expandedBytes };
    } catch (error) {
      if (!(error instanceof SafeParserError) || error.errorClass !== "malformed") throw error;
    }
    searchFrom = endstream.end;
  }
  throw new SafeParserError("malformed");
}

function findPdfEndstream(bytes, from) {
  const keyword = Buffer.from("endstream");
  let offset = from;
  while ((offset = bytes.indexOf(keyword, offset)) >= 0) {
    const before = offset > 0 ? bytes[offset - 1] : undefined;
    const after = bytes[offset + keyword.length];
    if (before !== undefined && isPdfWhitespace(before) && (after === undefined || isPdfWhitespace(after) || isPdfDelimiter(after))) {
      return { type: "word", value: "endstream", start: offset, end: offset + keyword.length };
    }
    offset += keyword.length;
  }
  return null;
}

function nextPdfToken(bytes, from) {
  let offset = from;
  while (offset < bytes.length) {
    const byte = bytes[offset];
    if (isPdfWhitespace(byte)) {
      offset += 1;
      continue;
    }
    if (byte === 0x25) {
      while (offset < bytes.length && bytes[offset] !== 0x0a && bytes[offset] !== 0x0d) offset += 1;
      continue;
    }
    break;
  }
  if (offset >= bytes.length) return null;
  const start = offset;
  const byte = bytes[offset];
  if (byte === 0x3c && bytes[offset + 1] === 0x3c) return { type: "dictStart", start, end: offset + 2 };
  if (byte === 0x3e && bytes[offset + 1] === 0x3e) return { type: "dictEnd", start, end: offset + 2 };
  if (byte === 0x5b) return { type: "arrayStart", start, end: offset + 1 };
  if (byte === 0x5d) return { type: "arrayEnd", start, end: offset + 1 };
  if (byte === 0x28) {
    let depth = 1;
    offset += 1;
    while (offset < bytes.length && depth > 0) {
      if (bytes[offset] === 0x5c) offset += 2;
      else {
        if (bytes[offset] === 0x28) depth += 1;
        if (bytes[offset] === 0x29) depth -= 1;
        offset += 1;
      }
    }
    if (depth !== 0) throw new SafeParserError("malformed");
    return { type: "value", start, end: offset };
  }
  if (byte === 0x3c) {
    offset += 1;
    while (offset < bytes.length && bytes[offset] !== 0x3e) offset += 1;
    if (offset >= bytes.length) throw new SafeParserError("malformed");
    return { type: "value", start, end: offset + 1 };
  }
  if (byte === 0x2f) {
    offset += 1;
    while (offset < bytes.length && !isPdfWhitespace(bytes[offset]) && !isPdfDelimiter(bytes[offset])) offset += 1;
    return { type: "name", value: decodePdfName(bytes.subarray(start + 1, offset)), start, end: offset };
  }
  if (isPdfDelimiter(byte)) return { type: "value", start, end: offset + 1 };
  while (offset < bytes.length && !isPdfWhitespace(bytes[offset]) && !isPdfDelimiter(bytes[offset])) offset += 1;
  const value = bytes.subarray(start, offset).toString("ascii");
  return { type: /^\d+$/.test(value) ? "number" : "word", value, start, end: offset };
}

function readPdfStreamSettings(bytes, start, end) {
  if (end - start > MAX_PDF_DICTIONARY_BYTES) throw new SafeParserError("size_limit");
  const tokens = [];
  let cursor = start + 2;
  while (cursor < end - 2) {
    const token = nextPdfToken(bytes, cursor);
    if (!token || token.start >= end - 2) break;
    tokens.push(token);
    cursor = token.end;
  }
  let length;
  let lengthSeen = false;
  let indirectLength = false;
  let filters = [];
  let filterSeen = false;
  let nesting = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "dictStart" || token.type === "arrayStart") {
      nesting += 1;
      continue;
    }
    if (token.type === "dictEnd" || token.type === "arrayEnd") {
      nesting -= 1;
      if (nesting < 0) throw new SafeParserError("malformed");
      continue;
    }
    if (nesting !== 0 || token.type !== "name") continue;
    if (token.value === "Length") {
      if (lengthSeen) throw new SafeParserError("suspicious");
      lengthSeen = true;
      const value = tokens[index + 1];
      if (!value || value.type !== "number") throw new SafeParserError("suspicious");
      if (tokens[index + 2]?.type === "number" && tokens[index + 3]?.type === "word" && tokens[index + 3]?.value === "R") {
        indirectLength = true;
      } else {
        length = Number.parseInt(value.value, 10);
      }
    }
    if (token.value === "Filter") {
      if (filterSeen) throw new SafeParserError("suspicious");
      filterSeen = true;
      const value = tokens[index + 1];
      if (!value) throw new SafeParserError("malformed");
      if (value.type === "name") {
        filters = [value.value];
      } else if (value.type === "arrayStart") {
        let next = index + 2;
        while (tokens[next]?.type !== "arrayEnd") {
          if (!tokens[next] || tokens[next].type !== "name") throw new SafeParserError("suspicious");
          filters.push(tokens[next].value);
          next += 1;
        }
      } else {
        throw new SafeParserError("suspicious");
      }
    }
  }
  if (!lengthSeen || (!indirectLength && (!Number.isSafeInteger(length) || length < 0)) || filters.length > 4) {
    throw new SafeParserError("malformed");
  }
  return { length: indirectLength ? undefined : length, filters };
}

async function measurePdfStream(bytes, filters, remaining) {
  const limit = Math.min(MAX_PDF_STREAM_BYTES, remaining);
  if (limit < 0) throw new SafeParserError("size_limit");
  let decoded = bytes;
  for (let index = 0; index < filters.length; index += 1) {
    const filter = filters[index];
    if (filter === "FlateDecode" || filter === "Fl") decoded = await decodeInflatedStream(decoded, limit);
    else if (filter === "RunLengthDecode" || filter === "RL") decoded = decodeRunLengthStream(decoded, limit);
    else if (filter === "ASCII85Decode" || filter === "A85") decoded = decodeAscii85Stream(decoded, limit);
    else if (filter === "ASCIIHexDecode" || filter === "AHx") decoded = decodeAsciiHexStream(decoded, limit);
    else if (filter === "DCTDecode" || filter === "DCT") {
      if (index !== filters.length - 1) throw new SafeParserError("suspicious");
      return measureJpegStream(decoded, remaining);
    } else if (filter === "Crypt") throw new SafeParserError("encrypted");
    else throw new SafeParserError("suspicious");
  }
  return boundedPdfStreamSize(decoded.length, remaining);
}

function boundedPdfStreamSize(size, remaining) {
  if (size > MAX_PDF_STREAM_BYTES || size > remaining) throw new SafeParserError("size_limit");
  return size;
}

function decodeInflatedStream(bytes, limit) {
  return new Promise((resolve, reject) => {
    const inflater = createInflate();
    let total = 0;
    const chunks = [];
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    inflater.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        inflater.destroy(new SafeParserError("size_limit"));
        return;
      }
      chunks.push(chunk);
    });
    inflater.once("error", (error) => finish(() => reject(
      error instanceof SafeParserError ? error : new SafeParserError("malformed")
    )));
    inflater.once("end", () => finish(() => resolve(Buffer.concat(chunks, total))));
    inflater.end(bytes);
  });
}

function decodeRunLengthStream(bytes, limit) {
  let total = 0;
  let offset = 0;
  let ended = false;
  while (offset < bytes.length) {
    const length = bytes[offset++];
    if (length === 128) {
      ended = true;
      break;
    }
    if (length <= 127) {
      const literalBytes = length + 1;
      if (offset + literalBytes > bytes.length) throw new SafeParserError("malformed");
      offset += literalBytes;
      total += literalBytes;
    } else {
      if (offset >= bytes.length) throw new SafeParserError("malformed");
      offset += 1;
      total += 257 - length;
    }
    if (total > limit) throw new SafeParserError("size_limit");
  }
  if (!ended) throw new SafeParserError("malformed");
  const decoded = Buffer.allocUnsafe(total);
  let input = 0;
  let output = 0;
  while (input < bytes.length) {
    const length = bytes[input++];
    if (length === 128) break;
    if (length <= 127) {
      const literalBytes = length + 1;
      bytes.copy(decoded, output, input, input + literalBytes);
      input += literalBytes;
      output += literalBytes;
    } else {
      decoded.fill(bytes[input++], output, output + 257 - length);
      output += 257 - length;
    }
  }
  return decoded;
}

function decodeAscii85Stream(bytes, limit) {
  const output = Buffer.allocUnsafe(measureAscii85Stream(bytes, limit));
  let outputLength = 0;
  let group = [];
  const writeGroup = (partial) => {
    const originalLength = group.length;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const count = partial ? originalLength - 1 : 4;
    for (let index = 0; index < count; index += 1) {
      output[outputLength++] = Math.floor(value / 256 ** (3 - index)) & 0xff;
    }
    group = [];
  };
  for (let offset = 0; offset < bytes.length; offset += 1) {
    const byte = bytes[offset];
    if (isPdfWhitespace(byte)) continue;
    if (byte === 0x7e && bytes[offset + 1] === 0x3e) {
      if (group.length > 1) writeGroup(true);
      break;
    }
    if (byte === 0x7a && group.length === 0) {
      output.fill(0, outputLength, outputLength + 4);
      outputLength += 4;
      continue;
    }
    group.push(byte - 0x21);
    if (group.length === 5) writeGroup(false);
  }
  return output;
}

function measureAscii85Stream(bytes, limit) {
  let outputLength = 0;
  let groupLength = 0;
  let groupValue = 0;
  let ended = false;
  for (let offset = 0; offset < bytes.length; offset += 1) {
    const byte = bytes[offset];
    if (isPdfWhitespace(byte)) continue;
    if (byte === 0x7e && bytes[offset + 1] === 0x3e) {
      if (groupLength === 1) throw new SafeParserError("malformed");
      if (groupLength > 1) outputLength += groupLength - 1;
      ended = true;
      offset += 1;
      for (let rest = offset + 1; rest < bytes.length; rest += 1) {
        if (!isPdfWhitespace(bytes[rest])) throw new SafeParserError("malformed");
      }
      break;
    }
    if (byte === 0x7a && groupLength === 0) {
      outputLength += 4;
    } else {
      if (byte < 0x21 || byte > 0x75) throw new SafeParserError("malformed");
      groupValue = groupValue * 85 + byte - 0x21;
      groupLength += 1;
      if (groupLength === 5) {
        if (groupValue > 0xffffffff) throw new SafeParserError("malformed");
        outputLength += 4;
        groupLength = 0;
        groupValue = 0;
      }
    }
    if (outputLength > limit) throw new SafeParserError("size_limit");
  }
  if (!ended) throw new SafeParserError("malformed");
  if (outputLength > limit) throw new SafeParserError("size_limit");
  return outputLength;
}

function decodeAsciiHexStream(bytes, limit) {
  const output = Buffer.allocUnsafe(Math.min(limit, Math.ceil(bytes.length / 2)));
  let outputLength = 0;
  let highNibble;
  let ended = false;
  for (let offset = 0; offset < bytes.length; offset += 1) {
    const byte = bytes[offset];
    if (isPdfWhitespace(byte)) continue;
    if (byte === 0x3e) {
      if (highNibble !== undefined) {
        if (outputLength >= limit) throw new SafeParserError("size_limit");
        output[outputLength++] = highNibble << 4;
      }
      ended = true;
      for (let rest = offset + 1; rest < bytes.length; rest += 1) {
        if (!isPdfWhitespace(bytes[rest])) throw new SafeParserError("malformed");
      }
      break;
    }
    const nibble = byte >= 0x30 && byte <= 0x39 ? byte - 0x30
      : byte >= 0x41 && byte <= 0x46 ? byte - 0x41 + 10
      : byte >= 0x61 && byte <= 0x66 ? byte - 0x61 + 10
      : -1;
    if (nibble < 0) throw new SafeParserError("malformed");
    if (highNibble === undefined) highNibble = nibble;
    else {
      if (outputLength >= limit) throw new SafeParserError("size_limit");
      output[outputLength++] = (highNibble << 4) | nibble;
      highNibble = undefined;
    }
  }
  if (!ended) throw new SafeParserError("malformed");
  return output.subarray(0, outputLength);
}

function measureJpegStream(bytes, remaining) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new SafeParserError("malformed");
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new SafeParserError("malformed");
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) throw new SafeParserError("malformed");
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (segmentLength < 8) throw new SafeParserError("malformed");
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      const components = bytes[offset + 7];
      const pixels = width * height;
      if (!width || !height || !components || pixels > MAX_PDF_IMAGE_PIXELS) throw new SafeParserError("size_limit");
      return boundedPdfStreamSize(pixels * components, remaining);
    }
    offset += segmentLength;
  }
  throw new SafeParserError("malformed");
}

function pdfStreamDataStart(bytes, offset) {
  if (bytes[offset] === 0x0d && bytes[offset + 1] === 0x0a) return offset + 2;
  if (bytes[offset] === 0x0a || bytes[offset] === 0x0d) return offset + 1;
  throw new SafeParserError("malformed");
}

function pdfStreamPayloadEnd(bytes, endstreamStart) {
  let end = endstreamStart;
  if (bytes[end - 1] === 0x0a) end -= 1;
  if (bytes[end - 1] === 0x0d) end -= 1;
  return end;
}

function decodePdfName(bytes) {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 1) {
    if (bytes[offset] === 0x23 && offset + 2 < bytes.length) {
      const escaped = Number.parseInt(bytes.subarray(offset + 1, offset + 3).toString("ascii"), 16);
      if (Number.isNaN(escaped)) throw new SafeParserError("malformed");
      result += String.fromCharCode(escaped);
      offset += 2;
    } else {
      result += String.fromCharCode(bytes[offset]);
    }
  }
  return result;
}

function isPdfWhitespace(byte) {
  return byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
}

function isPdfDelimiter(byte) {
  return byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e ||
    byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d ||
    byte === 0x2f || byte === 0x25;
}

function extractPlainText(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new SafeParserError("suspicious");
    return text;
  } catch (error) {
    if (error instanceof SafeParserError) throw error;
    throw new SafeParserError("malformed");
  }
}

async function validateDocxArchive(bytes) {
  assertBasicZipStructure(bytes);
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(new SafeParserError("malformed"));
        return;
      }
      let settled = false;
      let entries = 0;
      let expandedBytes = 0;
      const names = new Set();
      let hasContentTypes = false;
      let hasDocument = false;

      const fail = (errorClass) => {
        if (settled) return;
        settled = true;
        zipFile.close();
        reject(new SafeParserError(errorClass));
      };
      zipFile.on("error", () => fail("malformed"));
      zipFile.on("end", () => {
        if (settled) return;
        if (!hasContentTypes || !hasDocument) {
          fail("suspicious");
          return;
        }
        settled = true;
        resolve();
      });
      zipFile.on("entry", (entry) => {
        if (settled) return;
        entries += 1;
        const name = entry.fileName;
        if (entry.isEncrypted()) {
          fail("encrypted");
          return;
        }
        if (
          entries > MAX_DOCX_ENTRIES ||
          typeof name !== "string" ||
          name.length === 0 ||
          name.startsWith("/") ||
          name.includes("\\") ||
          name.split("/").some((part) => part === "..") ||
          names.has(name) ||
          !ALLOWED_ZIP_COMPRESSION_METHODS.has(entry.compressionMethod) ||
          !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize < 0 ||
          entry.uncompressedSize > MAX_DOCX_ENTRY_BYTES
        ) {
          fail("suspicious");
          return;
        }
        names.add(name);
        hasContentTypes ||= name === "[Content_Types].xml";
        hasDocument ||= name === "word/document.xml";
        expandedBytes += entry.uncompressedSize;
        const ratio = entry.compressedSize === 0
          ? entry.uncompressedSize === 0 ? 1 : Number.POSITIVE_INFINITY
          : entry.uncompressedSize / entry.compressedSize;
        if (expandedBytes > MAX_DOCX_EXPANDED_BYTES || ratio > MAX_DOCX_EXPANSION_RATIO) {
          fail("size_limit");
          return;
        }
        if (name.endsWith("/") && entry.uncompressedSize === 0) {
          if ((entry.crc32 >>> 0) !== 0) {
            fail("malformed");
            return;
          }
          zipFile.readEntry();
          return;
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail("malformed");
            return;
          }
          let actualBytes = 0;
          let actualCrc = 0;
          stream.on("error", () => fail("malformed"));
          stream.on("data", (chunk) => {
            actualBytes += chunk.length;
            actualCrc = crc32(chunk, actualCrc);
            if (actualBytes > entry.uncompressedSize || actualBytes > MAX_DOCX_ENTRY_BYTES) {
              stream.destroy();
              fail("size_limit");
            }
          });
          stream.on("end", () => {
            if (settled) return;
            if (actualBytes !== entry.uncompressedSize) {
              fail("malformed");
              return;
            }
            if ((actualCrc >>> 0) !== (entry.crc32 >>> 0)) {
              fail("malformed");
              return;
            }
            zipFile.readEntry();
          });
        });
      });
      zipFile.readEntry();
    });
  });
}

function assertBasicZipStructure(bytes) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) {
    throw new SafeParserError("malformed");
  }
  const minimum = Math.max(0, bytes.length - 65_557);
  let eocdOffset = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = bytes.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === bytes.length) {
        eocdOffset = offset;
        break;
      }
    }
  }
  if (eocdOffset < 0) throw new SafeParserError("malformed");
  const diskNumber = bytes.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = bytes.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocdOffset + 8);
  const totalEntries = bytes.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = bytes.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  const zip64Locator = eocdOffset >= 20 && bytes.readUInt32LE(eocdOffset - 20) === 0x07064b50;
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff ||
    centralDirectoryOffset + centralDirectorySize > eocdOffset ||
    zip64Locator
  ) {
    throw new SafeParserError("suspicious");
  }
}

function boundUtf8(text, maxBytes) {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) {
    return { text, originalBytes, truncated: false };
  }
  const chars = [];
  let used = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (used + charBytes > maxBytes) break;
    chars.push(char);
    used += charBytes;
  }
  return { text: chars.join(""), originalBytes, truncated: true };
}

async function readInput() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) throw new SafeParserError("size_limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function writeResult(result) {
  await new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(result), (error) => error ? reject(error) : resolve());
  });
}

main().catch((error) => {
  const errorClass = error instanceof SafeParserError ? error.errorClass : "malformed";
  return writeResult({ ok: false, errorClass });
});
