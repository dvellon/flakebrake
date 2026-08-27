export class DuplicateJsonKeyError extends SyntaxError {
  public constructor(key: string) {
    super(`Duplicate JSON object key ${JSON.stringify(key)}`);
    this.name = "DuplicateJsonKeyError";
  }
}

export function parseJsonRejectingDuplicateKeys(source: string): unknown {
  return new StrictJsonParser(source).parse();
}

class StrictJsonParser {
  readonly #source: string;
  #offset = 0;
  #depth = 0;

  public constructor(source: string) {
    this.#source = source;
  }

  public parse(): unknown {
    this.#skipWhitespace();
    const value = this.#parseValue();
    this.#skipWhitespace();
    if (this.#offset !== this.#source.length) {
      this.#fail("Unexpected data after the JSON value");
    }
    return value;
  }

  #parseValue(): unknown {
    const character = this.#source[this.#offset];
    switch (character) {
      case "{":
        return this.#parseObject();
      case "[":
        return this.#parseArray();
      case '"':
        return this.#parseString();
      case "t":
        return this.#parseKeyword("true", true);
      case "f":
        return this.#parseKeyword("false", false);
      case "n":
        return this.#parseKeyword("null", null);
      default:
        if (character === "-" || isDigit(character)) {
          return this.#parseNumber();
        }
        return this.#fail("Expected a JSON value");
    }
  }

  #parseObject(): Record<string, unknown> {
    this.#enterContainer();
    this.#offset += 1;
    this.#skipWhitespace();
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    if (this.#source[this.#offset] === "}") {
      this.#offset += 1;
      this.#leaveContainer();
      return result;
    }
    while (true) {
      if (this.#source[this.#offset] !== '"') {
        this.#fail("Expected a quoted JSON object key");
      }
      const key = this.#parseString();
      if (keys.has(key)) throw new DuplicateJsonKeyError(key);
      keys.add(key);
      this.#skipWhitespace();
      this.#expect(":");
      this.#skipWhitespace();
      result[key] = this.#parseValue();
      this.#skipWhitespace();
      const separator = this.#source[this.#offset];
      if (separator === "}") {
        this.#offset += 1;
        this.#leaveContainer();
        return result;
      }
      if (separator !== ",") this.#fail("Expected ',' or '}'");
      this.#offset += 1;
      this.#skipWhitespace();
    }
  }

  #parseArray(): unknown[] {
    this.#enterContainer();
    this.#offset += 1;
    this.#skipWhitespace();
    const result: unknown[] = [];
    if (this.#source[this.#offset] === "]") {
      this.#offset += 1;
      this.#leaveContainer();
      return result;
    }
    while (true) {
      result.push(this.#parseValue());
      this.#skipWhitespace();
      const separator = this.#source[this.#offset];
      if (separator === "]") {
        this.#offset += 1;
        this.#leaveContainer();
        return result;
      }
      if (separator !== ",") this.#fail("Expected ',' or ']'");
      this.#offset += 1;
      this.#skipWhitespace();
    }
  }

  #parseString(): string {
    this.#expect('"');
    let result = "";
    while (this.#offset < this.#source.length) {
      const character = this.#source[this.#offset] as string;
      this.#offset += 1;
      if (character === '"') return result;
      if (character === "\\") {
        const escape = this.#source[this.#offset];
        this.#offset += 1;
        switch (escape) {
          case '"':
          case "\\":
          case "/":
            result += escape;
            break;
          case "b":
            result += "\b";
            break;
          case "f":
            result += "\f";
            break;
          case "n":
            result += "\n";
            break;
          case "r":
            result += "\r";
            break;
          case "t":
            result += "\t";
            break;
          case "u":
            result += this.#parseUnicodeEscape();
            break;
          default:
            this.#fail("Invalid JSON string escape");
        }
        continue;
      }
      if (character.charCodeAt(0) < 0x20) {
        this.#fail("Unescaped control character in JSON string");
      }
      result += character;
    }
    return this.#fail("Unterminated JSON string");
  }

  #parseUnicodeEscape(): string {
    const digits = this.#source.slice(this.#offset, this.#offset + 4);
    if (!/^[0-9a-fA-F]{4}$/u.test(digits)) {
      this.#fail("Invalid JSON Unicode escape");
    }
    this.#offset += 4;
    return String.fromCharCode(Number.parseInt(digits, 16));
  }

  #parseNumber(): number {
    const start = this.#offset;
    if (this.#source[this.#offset] === "-") this.#offset += 1;
    if (this.#source[this.#offset] === "0") {
      this.#offset += 1;
      if (isDigit(this.#source[this.#offset])) {
        this.#fail("Leading zero in JSON number");
      }
    } else {
      this.#requireDigits("Expected an integer JSON number");
    }
    if (this.#source[this.#offset] === ".") {
      this.#offset += 1;
      this.#requireDigits("Expected digits after decimal point");
    }
    const exponent = this.#source[this.#offset];
    if (exponent === "e" || exponent === "E") {
      this.#offset += 1;
      const sign = this.#source[this.#offset];
      if (sign === "+" || sign === "-") this.#offset += 1;
      this.#requireDigits("Expected exponent digits");
    }
    const value = Number(this.#source.slice(start, this.#offset));
    if (!Number.isFinite(value)) this.#fail("JSON number is not finite");
    return value;
  }

  #requireDigits(message: string): void {
    const start = this.#offset;
    while (isDigit(this.#source[this.#offset])) this.#offset += 1;
    if (this.#offset === start) this.#fail(message);
  }

  #parseKeyword<T>(keyword: string, value: T): T {
    if (this.#source.slice(this.#offset, this.#offset + keyword.length) !== keyword) {
      this.#fail(`Expected ${keyword}`);
    }
    this.#offset += keyword.length;
    return value;
  }

  #skipWhitespace(): void {
    while (isJsonWhitespace(this.#source[this.#offset])) this.#offset += 1;
  }

  #expect(character: string): void {
    if (this.#source[this.#offset] !== character) {
      this.#fail(`Expected ${JSON.stringify(character)}`);
    }
    this.#offset += 1;
  }

  #enterContainer(): void {
    this.#depth += 1;
    if (this.#depth > 128) this.#fail("JSON nesting exceeds 128 levels");
  }

  #leaveContainer(): void {
    this.#depth -= 1;
  }

  #fail(message: string): never {
    throw new SyntaxError(`${message} at offset ${this.#offset}`);
  }
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function isJsonWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t" || value === "\n" || value === "\r";
}
