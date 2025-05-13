const fs = require("fs");
const path = require("path");

const headersRegex = /^(.*?): ?(.*)$/m; // Host: localhost

// Regex
const requestLineRegex = /^(.*) (.*) (HTTP\/\d*\.\d*)$/im; // GET /hello/world HTTP/1.1
const hostnameRegex = /[^:]*/; // localhost (excludes port)

function splitOnce(input, delimiter) {
  const idx = input.indexOf(delimiter);
  if (idx !== -1) {
    const before = input.slice(0, idx);
    const after = input.slice(idx + delimiter.length);
    return [before, after];
  }
  return [input, ''];
}

/**
 * Get JSON from file path
 * @param {string} filePath File path
 * @returns {object} JSON
 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/**
 * Parses a text file and returns an array of non-empty, non-comment lines.
 * Lines starting with `//` or `#`, or lines that are empty, are ignored.
 * @param {string} fileContent - The content of the text file as a string.
 * @returns {string[]} An array of strings containing the valid lines from the file.
 */
function parseTxtFile(fileContent) {
  const lines = fileContent.split('\n');
  const parsedLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip empty lines or comments
    if (line && !(line.startsWith('//') || line.startsWith('#'))) {
      parsedLines.push(line);
    }
  }
  return parsedLines;
}

/**
 * Matches IP
 * @param {string} ip IP to match
 * @param {object} matches Array of IP's or CIDR's to match with
 * @returns {string|boolean} IP/CIDR matched or false
 */
function ipMatch(ip, matches) {
  let matched = false;
  matches.forEach(match => {
    if (matched) return;
    const [subnet, bits] = match.split("/");
    if (bits) {
      const subnetBinary = subnet.split(".").map(octet => parseInt(octet).toString(2).padStart(8, "0")).join("");
      const ipBinary = ip.split(".").map(octet => parseInt(octet).toString(2).padStart(8, "0")).join("");
      const maskedSubnet = subnetBinary.substring(0, parseInt(bits));
      const maskedIp = ipBinary.substring(0, parseInt(bits));
      if (maskedSubnet === maskedIp) matched = match;
    } else {
      if (ip === match) matched = match;
    }
  });
  return matched;
}

/**
 * Parses array of string headers
 * @param {object} splitHeaders Array of headers as string (Host: localhost)
 * @returns {object} Parsed headers
 */
function getHeaders(splitHeaders) {
  const headers = {};
  for (let i = 0; i < splitHeaders.length; i++) {
    const header = splitHeaders[i];
    const m = header.match(headersRegex);
    if (m) headers[m[1]] = m[2];
  }
  return headers;
}

function testCredentials(serviceOptions, credential) {
  if (!credential) return false;
  
  let username = "";
  let password = credential;

  const index = credential.indexOf(":");
  if (index !== -1) {
    username = credential.slice(0, index);
    password = credential.slice(index + 1);
  }

  if (typeof serviceOptions.authPassword === "string") {
    return serviceOptions.authPassword === password;
  }
  if (Array.isArray(serviceOptions.authPassword)) {
    return serviceOptions.authPassword.includes(password);
  }
  if (typeof serviceOptions.authPassword === 'object') {
    return Object.hasOwn(serviceOptions.authPassword, username) &&
      serviceOptions.authPassword[username] === password;
  }
  return false;
}

/**
 * Find server object using hostname and optional URI for IP mapping and wildcard support.
 * Supports proxyHostnames with wildcards:
 *    - A pattern like "foo.*.example.com" will match "foo.bar.example.com".
 *    - A pattern like "**.example.com" will match "foo.example.com" or "foo.bar.baz.example.com".
 * For IP mapping, a proxyHostname starting with "@" (e.g. "@/cod") indicates that if the request comes
 * from an IP address and the URI starts with the specified path ("/cod"), the service should be used
 * and the matching path stripped from the URI.
 * @param {Map} services A Map of services with keys as identifiers and values as server objects
 * @param {string} hostname Hostname to search for
 * @param {string} [uri=""] Request URI (optional, used for IP mapping)
 * @param {object} [headers] - Optional headers object (used to extract Referer).
 * @returns {object|null} - Returns the matching service (or an object { service, stripPath } for IP mapping) or null if no match is found.
 */
function findService(services, hostname, uri, headers) {
  /**
   * Helper function that attempts to match a service based on hostname and URI.
   * It supports both IP mapping (using patterns starting with "@") and wildcard matching.
   *
   * @param {Map} services - A Map of services.
   * @param {string} hostname - The request hostname.
   * @param {string} uri - The request URI.
   * @returns {object|null} - Returns the service if found, or an object { service, stripPath } for IP mapping; otherwise, null.
   */
  function _matchService(services, hostname, uri) {
    for (const service of services.values()) {
      if (service && service.proxyHostnames) {
        for (const pattern of service.proxyHostnames) {
          if (pattern.startsWith("@")) {
            // IP mapping: e.g. pattern "@/cod" means if hostname is an IP and uri starts with "/cod"
            const pathPrefix = pattern.slice(1);
            if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) && uri.startsWith(pathPrefix)) {
              return { service, stripPath: pathPrefix };
            }
          } else {
            // Convert wildcard pattern to regex.
            const regexPattern = "^" + pattern
              .replace(/\./g, "\\.")
              .replace(/\*\*/g, ".*")
              .replace(/\*/g, "[^.]+") + "$";
            if (new RegExp(regexPattern, "i").test(hostname)) {
              return service;
            }
          }
        }
      }
    }
    return null;
  }

  // Try matching with the provided URI.
  let service = _matchService(services, hostname, uri);
  if (service) return service;
  
  // If no match found, attempt to adjust the URI based on the Referer header.
  if (headers) {
    const referer = getHeader(headers, "Referer");
    if (referer) {
      try {
        const refererUrl = new URL(referer);
        let prefix = refererUrl.pathname;
        // Remove a trailing slash if present.
        if (prefix.endsWith("/")) {
          prefix = prefix.slice(0, -1);
        }
        // If the prefix is non-root and not already present in uri, adjust the URI.
        if (prefix && prefix !== "/" && !uri.startsWith(prefix)) {
          const adjustedUri = prefix + uri;
          return _matchService(services, hostname, adjustedUri);
        }
      } catch (e) {
        // Ignore errors parsing the Referer.
      }
    }
  }
  
  return null;
}

/**
 * Formats strings with `%{}` syntax and dot notation (eg. `%{hello.world}` with options `{ hello: { world: "Hello, World!" } }`)
 * @param {string} string String to format
 * @param {object} options Object to use for formatting
 * @param {any} undef Value to use with undefined values
 * @returns {string} Formatted string
 */
function formatString(string, options, undef = "") {
  let formatted = string;
  // Object.entries(options).forEach(([key, value]) => formatted = formatted.replace(new RegExp(`%{${key}}`, "g"), value));
  formatted = formatted.replace(/%{(.*?)}/g, (string, match) => match.split(".").reduce((prev, curr) => prev[curr] ?? undef, options));
  return formatted;
}

/**
 * Parse string of cookies into object
 * @param {string} cookiesString String of cookies
 * @returns {object} Parsed cookies
 */
function parseCookies(cookiesString) {
  const cookies = {};
  const parts = cookiesString.split(/; /);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const [name, value] = splitOnce(part, "=");
    if (name) cookies[name] = value;
  }
  return cookies;
}


/**
 * Stringifies object of cookies
 * @param {object} cookies Object of cookies
 * @returns {string} Stringified cookies
 */
function stringifyCookies(cookies) {
  return Object.entries(cookies).map(([k,v]) => `${k}=${v}`).join("; ");
}

/**
 * Merges objects
 * @param {object} obj Object
 * @param {object} def Object of defaults
 * @returns {object} Merged objects
 */
function objectDefaults(obj, def) {
  if (typeof obj !== "object" || obj === null) return def;
  return (function checkEntries(object = obj, defaultObj = def) {
    Object.entries(defaultObj).forEach(([key, value]) => {
      if (object[key] === undefined) object[key] = value;
      else if (typeof value === "object" && value !== null && typeof object[key] === "object" && object[key] !== null) checkEntries(object[key], value);
    });
    return object;
  })();
}

class FileWatcher {
  constructor() {
    this.watchers = new Map();
  }
  /**
   * Watches for file changes
   * @param {string} filepath File path to watch
   * @param {function} onChange Callback for when file is changed
   */
  watch(filepath, onChange) {
    const isJson = filepath.endsWith('.json');
    const handler = () => {
      try {
        let data = fs.readFileSync(filepath, "utf-8");
        if (isJson) data = JSON.parse(data);
        onChange(data, filepath);
      } catch (err) {
        console.error(`Failed to read '${filepath}', error:`, err);
      }
    };

    if (!this.watchers.has(filepath)) {
      this.watchers.set(filepath, []);
    }
    fs.watchFile(filepath, handler);
    this.watchers.get(filepath).push(handler);
    handler(); // call onChange on init
  }
  /** Stops watching a specific file */
  unwatch(filepath) {
    if (this.watchers.has(filepath)) {
      const listeners = this.watchers.get(filepath);
      listeners.forEach(listener => fs.unwatchFile(filepath, listener));
      this.watchers.delete(filepath);
    }
  }
  /** Stops watching all files */
  unwatchAll() {
    for (const [filepath, listeners] of this.watchers.entries()) {
      listeners.forEach(listener => fs.unwatchFile(filepath, listener));
    }
    this.watchers.clear();
  }
}


/**
 * Dynamically creates a live-reloaded file map for a specified directory.
 * This map automatically includes all files in the specified folder, parsing JSON files into objects.
 * The map updates automatically when files are added, removed, or modified.
 * The file name (without extension) is used as the key in the map.
 * 
 * @param {string} globPattern - The file path pattern used to determine the directory and file extension.
 * @param {(content: any, key: string, filename: string) => any} [onRead] - An optional callback function to process file content before storing it in the map.
 * @returns {Map<string, any> & { init: Function, watch: Function, unwatch: Function }} - A Map object containing file contents with additional methods to initialize, watch, and unwatch file changes.
 */
function createLiveFileMap(globPattern, onRead) {
  const watchDirectory = path.dirname(globPattern);
  const fileExtension = path.extname(globPattern).slice(1);

  const map = new Map();
  map.init = init;
  map.watch = watch;
  map.unwatch = unwatch;

  function init() {
    const files = fs.readdirSync(watchDirectory);
    for (const filename of files) {
      if (filename.endsWith(`.${fileExtension}`) && !filename.startsWith('_')) {
        const fullPath = path.join(watchDirectory, filename);
        const key = path.basename(filename, `.${fileExtension}`);
        try {
          let fileContent = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
          if (onRead) fileContent = onRead(fileContent, key, filename);
          map.set(key, fileContent);
        } catch (err) {
          console.error(`Error reading JSON from ${fullPath}:`, err);
        }
      }
    }
  }

  function watch() {
    map.watcher = fs.watch(watchDirectory, (eventType, filename) => {
      if (!filename) return;
      const fullPath = path.join(watchDirectory, filename);
      if (eventType === 'rename') {
        if (fs.existsSync(fullPath)) {
          if (filename.endsWith(`.${fileExtension}`) && !filename.startsWith('_')) {
            // console.log(`File added or updated: ${filename}`);
            const key = path.basename(filename, `.${fileExtension}`);
            try {
              let fileContent = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
              if (onRead) fileContent = onRead(fileContent, key, filename);
              map.set(key, fileContent);
            } catch (err) {
              console.error(`Error reading JSON from ${fullPath}:`, err);
            }
          }
        } else {
          // console.log(`File removed: ${filename}`);
          const key = path.basename(filename, `.${fileExtension}`);
          map.delete(key);
        }
      } else if (eventType === 'change') {
        if (filename.endsWith(`.${fileExtension}`) && !filename.startsWith('_')) {
          // console.log(`File changed: ${filename}`);
          const key = path.basename(filename, `.${fileExtension}`);
          try {
            let fileContent = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
            if (onRead) fileContent = onRead(fileContent, key, filename);
            map.set(key, fileContent);
          } catch (err) {
            console.error(`Error reading JSON from ${fullPath}:`, err);
          }
        }
      }
    });
    // console.log('Watcher started.', watchDirectory);
  }

  function unwatch() {
    if (map.watcher) {
      map.watcher.close();
      // console.log('Watcher stopped.');
    }
  }

  init();
  return map;
}


/**
 * Finds specific header case-insensitive
 * @param {object} headers Headers
 * @param {string} name Header to look for
 * @returns {string} Header value
 */
function getHeader(headers, name) {
  const lowerName = name.toLowerCase();
  for (const key in headers) {
    if (Object.hasOwn(headers, key) && key.toLowerCase() === lowerName) {
      return headers[key];
    }
  }
  return undefined;
}

/**
 * Sets or deletes header case-insensitive
 * @param {object} headers Headers
 * @param {string} name Header to change
 * @param {string} value New header value
 */
function setHeader(headers, name, value) {
  const key = Object.keys(headers).find(i => i.toLowerCase() === name.toLowerCase());
  if (value) headers[key || name] = value;
  else delete headers[key || name];
}

/**
 * Timestamp for logs
 * @returns {string} Timestamp
 */
function timestamp() {
  const date = new Date();
  return `[${date.toLocaleString()}]\t`;
}

/**
 * Returns the options object deeply merged with the defaults.
 * Extranous properties are not included in the returned object.
 * @param {object} defaults - The object that contains the default values.
 * @param {object|undefined|null} [options] - The object to be merged into defaultObj. (it does not mutate this argument)
 * @returns {object} the merged object.
 *
 * @example
 * function myFunction(options) {
 *   options = defaults({
 *     foo: true,
 *     bar: {
 *       a: 1,
 *       b: 2,
 *     },
 *   }, options);
 *
 *   // do stuff with options
 * }
 */
function defaults(defaults, options) {
  function isObj(x) { return x !== null && typeof x === 'object'; }
  function hasOwn(obj, prop) { return Object.prototype.hasOwnProperty.call(obj, prop); }

  if (isObj(options)) for (let prop in defaults) {
    if (hasOwn(defaults, prop) && hasOwn(options, prop) && options[prop] !== undefined) {
      if (isObj(defaults[prop])) defaults(defaults[prop], options[prop]);
      else defaults[prop] = options[prop];
    }
  }
  return defaults;
}

/**
 * LogFlag
 * A lightweight logging utility that supports dynamic log level management using bitmasks.
 * @param {string[]} [levels=['ERROR', 'WARN', 'DEBUG', 'INFO', 'VERBOSE']] - The log levels available to use.
 * @return {Object} - The logger level object with flags used for managing log levels.
 * @example
 * const LOG = LogFlag();
 * LOG.setLevel(LOG.levels.VERBOSE);
 * 
 * LOG.INFO && console.log('Hello world');
 * LOG.WARN && console.warn('Warning message');
 */
function LogFlag(levels = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'VERBOSE']) {
  const LOG = Object.create({
    /**
     * Defines the log available to use.
     * @param {string[]} levelNames - Array of log level names.
     */
    defineLevels(levelNames) {
      this.levels = {};
      let bitmask = 0x1;
      for (const name of levelNames) {
        this.levels[name] = bitmask;
        Object.defineProperty(this, name, {
          value: false,
          writable: true,
          enumerable: true,
        });
        bitmask <<= 1;
      }
      this.levels.NONE = 0;
      this.levels.ALL = (bitmask - 1);
      this.enableLevels(this.levels.ALL); // Default to all levels enabled
      return this.levels;
    },
    /**
     * Enables all log levels up to and including the specified level.
     * @param {number} level - The bitmask of the log level up to which levels are enabled.
     * @example LOG.enableLevels(LOG.levels.INFO)
     */
    setLevel(level) {
      if (typeof level !== 'number') throw new Error(`Invalid argument (${level})! It should be a reference (e.g.: LOG.levels.ERROR) or a number.`);
      return this.enableLevels(level - 1 | level);
    },
    /**
     * Enables specific log levels based on the provided bitmask.
     * @param {number} levelsBitmask - Bitmask representing the log levels to enable.
     * @example LOG.enableLevels(LOG.levels.ERROR | LOG.levels.WARN | LOG.levels.VERBOSE)
     */
    enableLevels(levelsBitmask) {
      if (typeof levelsBitmask !== 'number') throw new Error(`Argument is not a bitmask! (${levelsBitmask}) It should be a number or a bitwise expression.`);
      Object.keys(this).forEach(LEVEL => {
        this[LEVEL] = Boolean(levelsBitmask & this.levels[LEVEL]);
      });
      return this.currentLevel = levelsBitmask;
    },
    /** Enables or disable a specific log levels by its name. */
    toggleLevel(levelName, enable) {
      if (this.levels[levelName] === undefined) throw new Error(`Invalid levelName! (${levelName})`);
      if (![true, false, 0, 1].includes(enable)) throw new Error(`Invalid value! ${levelName}: ${enable} is not true/false or 0/1!`);
      this.enableLevels(enable ? (this.currentLevel | this.levels[levelName]) : (this.currentLevel & ~this.levels[levelName]));
    },
    /**
     * Logs a message if the specified log level is enabled.
     * @param {number} level - The bitmask of the log level.
     * @param {string} message - The message to log.
     */
    log(level, ...args) {
      (this.currentLevel & level) && console.log(...args);
    },
  },
    {
      levels: { value: {}, writable: true, enumerable: false },
      currentLevel: { value: 0x0, writable: true, enumerable: false },
    });

  LOG.defineLevels(levels);
  return LOG;
}

function copyRecursiveSync(src, dest) {
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest);
    }
    fs.readdirSync(src).forEach(childItem => {
      copyRecursiveSync(path.join(src, childItem), path.join(dest, childItem));
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}

/**
 * Removes the indentation of multiline strings
 * @param  {string} str A template literal string
 * @return {string} A string without the indentation
 */
function dedent(str) {
  str = str.replace(/^[ \t]*\r?\n/, ''); // remove leading blank line
  var indent = /^[ \t]+/m.exec(str); // detected indent
  if (indent) str = str.replace(new RegExp('^' + indent[0], 'gm'), ''); // remove indent
  return str.replace(/(\r?\n)[ \t]+$/, '$1'); // remove trailling blank line
};

module.exports = {
  requestLineRegex,
  hostnameRegex,
  LogFlag,
  readJson,
  parseTxtFile,
  ipMatch,
  getHeaders,
  findService,
  formatString,
  parseCookies,
  stringifyCookies,
  objectDefaults,
  testCredentials,
  FileWatcher,
  createLiveFileMap,
  getHeader,
  setHeader,
  timestamp,
  defaults,
  copyRecursiveSync,
  dedent,
  splitOnce,
};
