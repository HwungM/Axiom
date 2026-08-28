const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function decode58(value) {
  const bytes = [0];
  for (const character of value) {
    let carry = alphabet.indexOf(character);
    if (carry < 0) throw new Error(`Invalid base58 character: ${character}`);
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 255;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 255);
      carry >>= 8;
    }
  }
  for (let index = 0; index < value.length - 1 && value[index] === '1'; index += 1) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

export function encode58(buffer) {
  if (!buffer.length) return '';
  const digits = [0];
  for (const byte of buffer) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let result = '';
  for (let index = 0; index < buffer.length - 1 && buffer[index] === 0; index += 1) result += '1';
  for (let index = digits.length - 1; index >= 0; index -= 1) result += alphabet[digits[index]];
  return result;
}

