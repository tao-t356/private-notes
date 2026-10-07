const TOTAL_CODEWORDS = [
  0,
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
  2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706
];

// QR Code error-correction level M, indexed by version 1..40.
const M_BLOCKS = [
  0,
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
  5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29,
  31, 33, 35, 37, 38, 40, 43, 45, 47, 49
];
const M_EC_CODEWORDS = [
  0,
  10, 16, 26, 36, 48, 64, 72, 88, 110, 130,
  150, 176, 198, 216, 240, 280, 308, 338, 364, 416,
  442, 476, 504, 560, 588, 644, 700, 728, 784, 812,
  868, 924, 980, 1036, 1064, 1120, 1204, 1260, 1316, 1372
];

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);

(function initializeGaloisField() {
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP_TABLE[index] = value;
    LOG_TABLE[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) {
    EXP_TABLE[index] = EXP_TABLE[index - 255];
  }
}());

/** @param {number} value */
function bchDigit(value) {
  let digit = 0;
  while (value !== 0) {
    digit += 1;
    value >>>= 1;
  }
  return digit;
}

/** @param {number} left @param {number} right */
function galoisMultiply(left, right) {
  if (left === 0 || right === 0) return 0;
  return EXP_TABLE[LOG_TABLE[left] + LOG_TABLE[right]];
}

/** @param {number[] | Uint8Array} first @param {number[] | Uint8Array} second */
function multiplyPolynomials(first, second) {
  const result = new Uint8Array(first.length + second.length - 1);
  for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1) {
    for (let secondIndex = 0; secondIndex < second.length; secondIndex += 1) {
      result[firstIndex + secondIndex] ^= galoisMultiply(first[firstIndex], second[secondIndex]);
    }
  }
  return result;
}

/** @param {number} degree */
function makeGeneratorPolynomial(degree) {
  let polynomial = new Uint8Array([1]);
  for (let index = 0; index < degree; index += 1) {
    polynomial = multiplyPolynomials(polynomial, [1, EXP_TABLE[index]]);
  }
  return polynomial;
}

/** @param {Uint8Array} data @param {number} degree */
function makeErrorCorrection(data, degree) {
  const generator = makeGeneratorPolynomial(degree);
  const remainder = new Uint8Array(data.length + degree);
  remainder.set(data);
  for (let index = 0; index < data.length; index += 1) {
    const coefficient = remainder[index];
    if (coefficient === 0) continue;
    for (let generatorIndex = 0; generatorIndex < generator.length; generatorIndex += 1) {
      remainder[index + generatorIndex] ^= galoisMultiply(generator[generatorIndex], coefficient);
    }
  }
  return remainder.slice(data.length);
}

/** @param {boolean[]} bits @param {number} value @param {number} length */
function appendBits(bits, value, length) {
  for (let index = length - 1; index >= 0; index -= 1) {
    bits.push(((value >>> index) & 1) === 1);
  }
}

/** @param {Uint8Array} bytes @param {number} version */
function makeDataCodewords(bytes, version) {
  const dataCapacityBits = (TOTAL_CODEWORDS[version] - M_EC_CODEWORDS[version]) * 8;
  const countBits = version < 10 ? 8 : 16;
  const headerBits = 4 + countBits;
  if (bytes.length >= (1 << countBits) || headerBits + bytes.length * 8 > dataCapacityBits) {
    throw new Error('分享链接过长，无法生成二维码');
  }

  /** @type {boolean[]} */
  const bits = [];
  appendBits(bits, 0x4, 4); // Byte mode.
  appendBits(bits, bytes.length, countBits);
  for (const byte of bytes) appendBits(bits, byte, 8);
  if (bits.length + 4 <= dataCapacityBits) appendBits(bits, 0, 4);
  while (bits.length < dataCapacityBits && bits.length % 8 !== 0) bits.push(false);
  const padBytes = (dataCapacityBits - bits.length) / 8;
  for (let index = 0; index < padBytes; index += 1) appendBits(bits, index % 2 === 0 ? 0xec : 0x11, 8);

  const result = new Uint8Array(dataCapacityBits / 8);
  for (let index = 0; index < result.length; index += 1) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | (bits[index * 8 + bit] ? 1 : 0);
    result[index] = value;
  }
  return result;
}

/** @param {Uint8Array} bytes @param {number} version */
function makeCodewords(bytes, version) {
  const data = makeDataCodewords(bytes, version);
  const blockCount = M_BLOCKS[version];
  const totalCodewords = TOTAL_CODEWORDS[version];
  const totalErrorCodewords = M_EC_CODEWORDS[version];
  const dataCodewords = totalCodewords - totalErrorCodewords;
  const shortBlockTotal = Math.floor(totalCodewords / blockCount);
  const shortBlockData = Math.floor(dataCodewords / blockCount);
  const longBlockCount = totalCodewords % blockCount;
  const ecCodewords = shortBlockTotal - shortBlockData;
  const blocks = [];
  let offset = 0;

  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const blockLength = shortBlockData + (blockIndex >= blockCount - longBlockCount ? 1 : 0);
    const blockData = data.slice(offset, offset + blockLength);
    offset += blockLength;
    blocks.push({ data: blockData, error: makeErrorCorrection(blockData, ecCodewords) });
  }

  const result = new Uint8Array(totalCodewords);
  let resultIndex = 0;
  const maxDataLength = shortBlockData + (longBlockCount > 0 ? 1 : 0);
  for (let index = 0; index < maxDataLength; index += 1) {
    for (const block of blocks) {
      if (index < block.data.length) result[resultIndex++] = block.data[index];
    }
  }
  for (let index = 0; index < ecCodewords; index += 1) {
    for (const block of blocks) result[resultIndex++] = block.error[index];
  }
  return result;
}

/** @param {number} version */
function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const interval = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const positions = [size - 7];
  for (let index = 1; index < count - 1; index += 1) {
    positions[index] = positions[index - 1] - interval;
  }
  positions.push(6);
  return positions.reverse();
}

/** @param {number} version */
function makeMatrix(version) {
  const size = version * 4 + 17;
  const data = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);
  /** @type {(row:number,column:number,value:boolean,isReserved:boolean)=>void} */
  const set = (row, column, value, isReserved) => {
    const index = row * size + column;
    data[index] = value ? 1 : 0;
    if (isReserved) reserved[index] = 1;
  };

  const finderPositions = [[0, 0], [size - 7, 0], [0, size - 7]];
  for (const [row, column] of finderPositions) {
    for (let rowOffset = -1; rowOffset <= 7; rowOffset += 1) {
      if (row + rowOffset < 0 || row + rowOffset >= size) continue;
      for (let columnOffset = -1; columnOffset <= 7; columnOffset += 1) {
        if (column + columnOffset < 0 || column + columnOffset >= size) continue;
        const dark = (rowOffset >= 0 && rowOffset <= 6 && (columnOffset === 0 || columnOffset === 6))
          || (columnOffset >= 0 && columnOffset <= 6 && (rowOffset === 0 || rowOffset === 6))
          || (rowOffset >= 2 && rowOffset <= 4 && columnOffset >= 2 && columnOffset <= 4);
        set(row + rowOffset, column + columnOffset, dark, true);
      }
    }
  }

  for (let index = 8; index < size - 8; index += 1) {
    set(index, 6, index % 2 === 0, true);
    set(6, index, index % 2 === 0, true);
  }

  const positions = alignmentPositions(version);
  for (let rowIndex = 0; rowIndex < positions.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < positions.length; columnIndex += 1) {
      if ((rowIndex === 0 && columnIndex === 0)
        || (rowIndex === 0 && columnIndex === positions.length - 1)
        || (rowIndex === positions.length - 1 && columnIndex === 0)) continue;
      const row = positions[rowIndex];
      const column = positions[columnIndex];
      for (let rowOffset = -2; rowOffset <= 2; rowOffset += 1) {
        for (let columnOffset = -2; columnOffset <= 2; columnOffset += 1) {
          const dark = rowOffset === -2 || rowOffset === 2 || columnOffset === -2 || columnOffset === 2
            || (rowOffset === 0 && columnOffset === 0);
          set(row + rowOffset, column + columnOffset, dark, true);
        }
      }
    }
  }

  return { size, data, reserved, set };
}

/** @param {number} value */
function formatBch(value) {
  let remainder = value << 10;
  while (bchDigit(remainder) - bchDigit(G15) >= 0) {
    remainder ^= G15 << (bchDigit(remainder) - bchDigit(G15));
  }
  return ((value << 10) | remainder) ^ G15_MASK;
}

/** @param {number} version */
function versionBch(version) {
  let remainder = version << 12;
  while (bchDigit(remainder) - bchDigit(G18) >= 0) {
    remainder ^= G18 << (bchDigit(remainder) - bchDigit(G18));
  }
  return (version << 12) | remainder;
}

/** @param {{size:number,data:Uint8Array,reserved:Uint8Array,set:Function}} matrix @param {number} mask */
function addFormatInfo(matrix, mask) {
  const bits = formatBch(mask);
  const size = matrix.size;
  for (let index = 0; index < 15; index += 1) {
    const dark = ((bits >>> index) & 1) === 1;
    if (index < 6) matrix.set(index, 8, dark, true);
    else if (index < 8) matrix.set(index + 1, 8, dark, true);
    else matrix.set(size - 15 + index, 8, dark, true);
    if (index < 8) matrix.set(8, size - index - 1, dark, true);
    else if (index < 9) matrix.set(8, 15 - index, dark, true);
    else matrix.set(8, 15 - index - 1, dark, true);
  }
  matrix.set(size - 8, 8, true, true);
}

/** @param {{size:number,data:Uint8Array,reserved:Uint8Array,set:Function}} matrix @param {number} version */
function addVersionInfo(matrix, version) {
  if (version < 7) return;
  const bits = versionBch(version);
  const size = matrix.size;
  for (let index = 0; index < 18; index += 1) {
    const row = Math.floor(index / 3);
    const column = index % 3 + size - 11;
    const dark = ((bits >>> index) & 1) === 1;
    matrix.set(row, column, dark, true);
    matrix.set(column, row, dark, true);
  }
}

/** @param {{size:number,data:Uint8Array,reserved:Uint8Array,set:Function}} matrix @param {Uint8Array} codewords */
function addData(matrix, codewords) {
  const size = matrix.size;
  let direction = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column -= 1;
    while (true) {
      for (let offset = 0; offset < 2; offset += 1) {
        const currentColumn = column - offset;
        const currentIndex = row * size + currentColumn;
        if (!matrix.reserved[currentIndex]) {
          const dark = byteIndex < codewords.length && ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
          matrix.data[currentIndex] = dark ? 1 : 0;
          bitIndex -= 1;
          if (bitIndex < 0) {
            byteIndex += 1;
            bitIndex = 7;
          }
        }
      }
      row += direction;
      if (row < 0 || row >= size) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }
}

/** @param {number} mask @param {number} row @param {number} column */
function maskValue(mask, row, column) {
  switch (mask) {
    case 0: return (row + column) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return column % 3 === 0;
    case 3: return (row + column) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5: return (row * column) % 2 + (row * column) % 3 === 0;
    case 6: return ((row * column) % 2 + (row * column) % 3) % 2 === 0;
    default: return ((row * column) % 3 + (row + column) % 2) % 2 === 0;
  }
}

/** @param {{size:number,data:Uint8Array,reserved:Uint8Array,set:Function}} matrix @param {number} mask */
function applyMask(matrix, mask) {
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      const index = row * matrix.size + column;
      if (!matrix.reserved[index] && maskValue(mask, row, column)) matrix.data[index] ^= 1;
    }
  }
}

/** @param {{size:number,data:Uint8Array,reserved:Uint8Array,set:Function}} matrix */
function penaltyScore(matrix) {
  const size = matrix.size;
  let score = 0;
  for (let row = 0; row < size; row += 1) {
    let sameRow = 0;
    let sameColumn = 0;
    let lastRow = -1;
    let lastColumn = -1;
    for (let column = 0; column < size; column += 1) {
      const rowValue = matrix.data[row * size + column];
      if (rowValue === lastRow) sameRow += 1;
      else {
        if (sameRow >= 5) score += 3 + sameRow - 5;
        lastRow = rowValue;
        sameRow = 1;
      }
      const columnValue = matrix.data[column * size + row];
      if (columnValue === lastColumn) sameColumn += 1;
      else {
        if (sameColumn >= 5) score += 3 + sameColumn - 5;
        lastColumn = columnValue;
        sameColumn = 1;
      }
    }
    if (sameRow >= 5) score += 3 + sameRow - 5;
    if (sameColumn >= 5) score += 3 + sameColumn - 5;
  }
  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const total = matrix.data[row * size + column]
        + matrix.data[row * size + column + 1]
        + matrix.data[(row + 1) * size + column]
        + matrix.data[(row + 1) * size + column + 1];
      if (total === 0 || total === 4) score += 3;
    }
  }
  for (let row = 0; row < size; row += 1) {
    let rowBits = 0;
    let columnBits = 0;
    for (let column = 0; column < size; column += 1) {
      rowBits = ((rowBits << 1) & 0x7ff) | matrix.data[row * size + column];
      columnBits = ((columnBits << 1) & 0x7ff) | matrix.data[column * size + row];
      if (column >= 10 && (rowBits === 0x5d0 || rowBits === 0x05d)) score += 40;
      if (column >= 10 && (columnBits === 0x5d0 || columnBits === 0x05d)) score += 40;
    }
  }
  let dark = 0;
  for (const value of matrix.data) dark += value;
  score += Math.abs(Math.ceil((dark * 100 / matrix.data.length) / 5) - 10) * 10;
  return score;
}

/** @param {{size:number,data:Uint8Array,reserved:Uint8Array,set:Function}} matrix */
function cloneMatrix(matrix) {
  const data = new Uint8Array(matrix.data);
  const reserved = new Uint8Array(matrix.reserved);
  return {
    size: matrix.size,
    data: data,
    reserved: reserved,
    /** @param {number} row @param {number} column @param {boolean} value @param {boolean} isReserved */
    set(/** @type {number} */ row, /** @type {number} */ column, /** @type {boolean} */ value, /** @type {boolean} */ isReserved) {
      const index = row * matrix.size + column;
      data[index] = value ? 1 : 0;
      if (isReserved) reserved[index] = 1;
    }
  };
}

/**
 * Encodes text as a standards-compliant QR Code matrix without network access
 * or a runtime dependency. The input is kept in the matrix only; it is never
 * inserted into the SVG or sent anywhere.
 * @param {string} text
 * @returns {boolean[][]}
 */
export function createQrMatrix(text) {
  if (!text) throw new Error('二维码内容不能为空');
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let candidate = 1; candidate <= 40; candidate += 1) {
    const countBits = candidate < 10 ? 8 : 16;
    const capacity = (TOTAL_CODEWORDS[candidate] - M_EC_CODEWORDS[candidate]) * 8;
    if (bytes.length < (1 << countBits) && 4 + countBits + bytes.length * 8 <= capacity) {
      version = candidate;
      break;
    }
  }
  if (!version) throw new Error('分享链接过长，无法生成二维码');

  const codewords = makeCodewords(bytes, version);
  const base = makeMatrix(version);
  addVersionInfo(base, version);
  addFormatInfo(base, 0);
  addData(base, codewords);

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = cloneMatrix(base);
    applyMask(candidate, mask);
    addFormatInfo(candidate, mask);
    const score = penaltyScore(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (!best) throw new Error('二维码生成失败');

  const matrix = [];
  for (let row = 0; row < best.size; row += 1) {
    const line = [];
    for (let column = 0; column < best.size; column += 1) {
      line.push(best.data[row * best.size + column] === 1);
    }
    matrix.push(line);
  }
  return matrix;
}

/** @param {string} text */
export function createQrSvg(text) {
  const matrix = createQrMatrix(text);
  const margin = 4;
  const size = matrix.length;
  const total = size + margin * 2;
  let path = '';
  for (let row = 0; row < size; row += 1) {
    let runStart = -1;
    for (let column = 0; column <= size; column += 1) {
      const dark = column < size && matrix[row][column];
      if (dark && runStart < 0) runStart = column;
      if ((!dark || column === size) && runStart >= 0) {
        const width = column - runStart;
        path += `M${runStart + margin} ${row + margin}h${width}v1h-${width}z`;
        runStart = -1;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" role="img" aria-labelledby="qrSvgTitle qrSvgDescription" shape-rendering="crispEdges"><title id="qrSvgTitle">二维码分享链接</title><desc id="qrSvgDescription">扫描此二维码打开完整的加密分享链接。</desc><path fill="#ffffff" d="M0 0h${total}v${total}H0z"/><path fill="#111827" d="${path}"/></svg>`;
}
