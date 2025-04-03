#!/usr/bin/env node
const net = require("net");
const tls = require("tls");
const path = require('path');
const fs = require("fs");
const {
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
  FileWatcher,
  createLiveFileMap,
  getHeader,
  setHeader,
  timestamp,
  defaults,
  copyRecursiveSync,
  dedent,
} = require("./utils");

const CLINAME = 'proxy-cli';
const EXAMPLE_DIR = path.join(__dirname, "example");

global.LOG = LogFlag([
  "PROXY_ERROR",
  "PROXY_WARN",
  "PROXY_INFO",
  "PROXY_DEBUG",
  "AUTH_DEBUG",
  "AUTH_ERROR",
  "AUTH_DENIED",
  "AUTH_GRANTED",
  "SERVICE_ERROR",
  "SERVICE_WARN",
  "SERVICE_INFO",
  "SERVICE_DEBUG",
  "CONNECTION_ERROR",
  "CONNECTION_REFUSED",
  "CONNECTION_INFO",
  "CONNECTION_ACCEPTED",
  "CONNECTION_DEBUG",
]);

// Global variables
let proxyServer;            // proxy server instance
let proxyConfig = {};       // Proxy global config (config.json)
let serviceDefaults = {};   // Services default config (services/_defaults.json)
let fw = new FileWatcher(); // used to watch global files (config, html, ip lists)
let services = new Map();   // used to watch services/*.json, but they are dynamically maped to this map (live reloaded, included, removed)
let globalWhitelist;
let globalBlacklist;
let rememberedIps = new Map(); // In-memory IP storage for "rememberIp" authentication


function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (args.length === 0 || args.includes("--help")) {
    displayHelp();
    process.exit(0);
  }
  else if (command === "create") {
    scaffoldServer();
    process.exit(0);
  }
  else if (command === "start") {
    startProxy();
  }
  else {
    console.error("Unknown command:", command);
    displayHelp();
    process.exit(1);
  }
}

function displayHelp() {
  console.log(`
    Usage: ${CLINAME} <command>

    Commands:
      start   Start the proxy server
      create  Scaffolds a new server setup in an empty folder
      --help  Show this help message
  `);
}

function scaffoldServer() {
  console.log("Scaffolding new server...");

  if (!fs.existsSync(EXAMPLE_DIR)) {
    console.error("Error! The Example directory doesn't exist.", EXAMPLE_DIR);
    process.exit(1);
  }

  const excludedFiles = {
    darwin: ["start.bat", "start.sh"],
    linux: ["start.bat", "start.command"],
    win32: ["start.command", "start.sh"]
  }[os.platform()] || [];

  let conflict = false;
  fs.readdirSync(EXAMPLE_DIR).forEach(file => {
    const src = path.join(EXAMPLE_DIR, file);
    const dest = path.join(process.cwd(), file);
    if (['.DS_Store', 'Thumbs.db', 'desktop.ini', ...excludedFiles].includes(file)) return;
    if (fs.existsSync(dest) && !fs.statSync(dest).isDirectory()) {
      console.warn(`File already exists and would be overwritten: ${file}`);
      conflict = true;
    }
  });

  if (conflict) {
    console.log(`Aborted.`);
    return;
  }

  fs.readdirSync(EXAMPLE_DIR).forEach(file => {
    const src = path.join(EXAMPLE_DIR, file);
    const dest = path.join(process.cwd(), file);
    if (['.DS_Store', 'Thumbs.db', 'desktop.ini', ...excludedFiles].includes(file)) return;
    copyRecursiveSync(src, dest);
    console.log(`Copied: ${file}`);
  });

  console.log("Server scaffolding complete.\n");
  console.log(" - Edit files, see readme file for instructions");
  console.log(` - To start the server run \`${CLINAME} start\``);
}

function startProxy() {
  console.log("Starting proxy server...");

  // Proxy Configuration
  fw.watch("config.json", (json, filename) => {
    proxyConfig = json;
    LOG.PROXY_INFO && console.log(timestamp(), `[PROXY_CONFIG] Loaded Proxy Config (${filename})`);

    // set log level
    try {
      if (typeof proxyConfig.logLevel === 'number') LOG.setLevel(proxyConfig.logLevel);
      if (typeof proxyConfig.logLevel === 'object') Object.entries(proxyConfig.logLevel).forEach(([level, b]) => LOG.toggleLevel(level, b));
    } catch (err) {
      LOG.PROXY_ERROR && console.error(timestamp(), `[PROXY_CONFIG_ERROR] Failed to configure log level.`, String(err));
    }
  });

  // Auth page html
  fw.watch(path.join(__dirname, "auth.html"), file => {
    defaultAuthHtmlFile = file;
    LOG.PROXY_DEBUG && console.log(timestamp(), "[PROXY_CONFIG] Loaded authorization HTML");
  });

  // Global black/white list
  if (proxyConfig.blacklist) fw.watch(proxyConfig.blacklist, file => {
    globalBlacklist = parseTxtFile(file);
    LOG.PROXY_INFO && console.log(timestamp(), "[PROXY_CONFIG] Loaded global blacklist", `(${globalBlacklist.length} entries)`);
  });
  if (proxyConfig.whitelist) fw.watch(proxyConfig.whitelist, file => {
    globalWhitelist = parseTxtFile(file);
    LOG.PROXY_INFO && console.log(timestamp(), "[PROXY_CONFIG] Loaded global whitelist", `(${globalWhitelist.length} entries)`);
  });

  // Defaults for services
  fw.watch("./services/_defaults.json", (json, filename) => {
    serviceDefaults = json;
    LOG.SERVICE_INFO && console.log(timestamp(), `[PROXY_CONFIG] Loaded serviceDefaults config (${filename})`);
  });

  // Dynamically load services into a map that is live reloaded
  services = createLiveFileMap('./services/*.json', (service, key, filename) => {
    LOG.SERVICE_INFO && console.log(timestamp(), "[SERVICE_INFO] Loaded service:", key);
    LOG.SERVICE_DEBUG && console.log(service);
    return service;
  });
  services.watch();

  // Start proxy server
  proxyServer = (proxyConfig.tls ? tls : net).createServer({
    key: proxyConfig.tls ? fs.readFileSync(proxyConfig.key) : undefined,
    cert: proxyConfig.tls ? fs.readFileSync(proxyConfig.cert) : undefined,
    ...proxyConfig.additionalProxyServerOptions
  });
  proxyServer.on(proxyConfig.tls ? "secureConnection" : "connection", connectionHandler);
  proxyServer.listen(proxyConfig.port, proxyConfig.hostname, () => {
    LOG.PROXY_INFO && displaySummary();
    LOG.PROXY_INFO && console.log(timestamp(), '[PROXY_INFO] Proxy started...');
  });

  process.on("SIGINT", shutdownProxy);
  process.on("SIGTERM", shutdownProxy);
}

function displaySummary() {
  console.log(dedent(`
    ================================================================================
      REVERSE PROXY SERVER SUMMARY
    ================================================================================

    Proxy Listening on:
      Hostname: ${proxyConfig.hostname || "0.0.0.0"}
      Port: ${proxyConfig.port || 80}
      
      TLS: ${proxyConfig.tls ? "Enabled (Serving HTTPS)" : "Not enabled (Serving HTTP)"}
        - Key: ${proxyConfig.key || "Not Provided"}
        - Certificate: ${proxyConfig.cert || "Not Provided"}
    
    Logging Level: ${LOG.currentLevel}

    Global Whitelist: ${globalWhitelist?.length ?? 'Not Configured'} entries
    Global Blacklist: ${globalBlacklist?.length ?? 'Not Configured'} entries

    Registered Services: (${services.size} services)
    --------------------------------------------------------------------------------
  `));
  services.forEach((service, key) => {
    let credentialType = "None";
    if (service.auth ) {
      if (service.authPassword && typeof service.authPassword === "string") credentialType = "Password";
      else if (Array.isArray(service.authPassword)) credentialType = "Multiple Passwords";
      else if (typeof service.authPassword === "object") credentialType = "Multiple Username:Password";
    }
    console.log(dedent(`
      ${key}:
        Hostnames:  ${service.proxyHostnames.join(", ")}
        Target:     ${service.serverHostname}:${service.serverPort}
        TLS:        ${service.useTls ? "Enabled (https)" : "Disabled"}
        Auth:       ${service.auth ? `Protected (${service.authType})` : "PUBLIC"}
        Credential: ${credentialType}
    `));
  });
  console.log('='.repeat(80));
}


function connectionHandler(proxyConnection) {
  const ip = proxyConnection.remoteAddress?.split("::ffff:")[1] || proxyConnection.remoteAddress;

  if (!ip) {
    LOG.CONNECTION_ERROR && console.error(timestamp(), `[CONNECTION_ERROR] No IP?!`, proxyConnection);
    return proxyConnection.destroy(); // Why does this happen sometimes?
  }

  // Global Blacklist
  if (globalBlacklist && ipMatch(ip, globalBlacklist)) {
    LOG.CONNECTION_REFUSED && console.log(timestamp(), `🖥 ${ip}`, `[CONNECTION_BLOCKED_BLACKLISTED] Blacklisted attempted to connect!`);
    return proxyConnection.destroy();
  }
  // Global Whitelist
  if (globalWhitelist && !ipMatch(ip, globalWhitelist)) {
    LOG.CONNECTION_REFUSED && console.log(timestamp(), `🖥 ${ip}`, `[CONNECTION_BLOCKED_UNWHITELISTED] Unwhitelisted attempted to connect!`);
    return proxyConnection.destroy();
  }

  let connectionToService;

  proxyConnection.on("data", data => {
    // Proxy server on data
    const [rawHeaders, ...splitRawData] = data.toString().split("\r\n\r\n");
    const rawData = splitRawData.join("\r\n\r\n");
    const splitHeaders = rawHeaders.split("\r\n");

    let [requestLine, method, uri, httpVer] = splitHeaders.splice(0, 1)[0].match(requestLineRegex) || []; // Get and remove request line from headers

    if (requestLine) {
      // Get headers
      const headers = getHeaders(splitHeaders);

      let realIp = serviceDefaults.realIpHeader ? headers[serviceDefaults.realIpHeader] : null;
      let ipFormatted = realIp ? `🏛️ ${ip} 🖥 ${realIp}` : `🖥 ${ip}`;

      // Get hostname
      const [hostname] = getHeader(headers, "Host")?.match(hostnameRegex) || [];
      if (!hostname) {
        LOG.CONNECTION_REFUSED && console.log(timestamp(), ipFormatted, `[CONNECTION_REFUSED_NO_HOST] tried to connect without 'host' header`);
        return proxyConnection.destroy();
      }

      // Find service to handle this request using wildcard, IP mapping, and Referer-based adjustment
      let serviceResult = findService(services, hostname, uri, headers);
      if (!serviceResult) {
        LOG.CONNECTION_REFUSED && console.log(timestamp(), ipFormatted, '→', hostname, `[PROXY_SERVICE_NOT_FOUND] tried to reach unknown hostname ${hostname}`);
        return proxyConnection.destroy();
      }
      let service = serviceResult;
      if (serviceResult.service) {
        service = serviceResult.service;
        if (serviceResult.stripPath) {
          // If original URI doesn't already contain the stripPath,
          // attempt to adjust using the Referer header.
          if (!uri.startsWith(serviceResult.stripPath)) {
            const referer = getHeader(headers, "Referer");
            if (referer) {
              try {
                const refererUrl = new URL(referer);
                let prefix = refererUrl.pathname;
                if (prefix.endsWith("/")) prefix = prefix.slice(0, -1);
                uri = prefix + uri;
              } catch(e) {}
            }
          }
          // Strip the prefix.
          uri = uri.slice(serviceResult.stripPath.length) || "/";
        }
      }

      // Make service options inherit default options
      const serviceOptions = objectDefaults(service, serviceDefaults || {});

      // Get real IP (if using some sort of proxy like Cloudflare)
      realIp = serviceOptions.realIpHeader ? headers[serviceOptions.realIpHeader] : null;
      ipFormatted = realIp ? `🏛️ ${ip} 🖥 ${realIp}` : `🖥 ${ip}`;

      // Make sure using supported version
      if (serviceOptions.supportedVersions && !serviceOptions.supportedVersions.includes(httpVer)) {
        LOG.CONNECTION_REFUSED && console.log(timestamp(), ipFormatted, '→', hostname, `[CONNECTION_UNSUPPORTED_VERSION] using unsupported version ${httpVer}`);
        return proxyConnection.destroy();
      }

      // Check whitelist/blacklist again with custom options
      // Whitelist
      const whitelist = serviceOptions.whitelist !== serviceDefaults.whitelist ? readJson(serviceOptions.whitelist) : null;
      if (whitelist && !ipMatch(ip, whitelist)) {
        LOG.CONNECTION_REFUSED && console.log(timestamp(), ipFormatted, '→', hostname, `[CONNECTION_REFUSED_UNWHITELISTED] Unwhitelisted attempted to connect!`);
        return proxyConnection.destroy();
      }
      // Blacklist
      const blacklist = serviceOptions.blacklist !== serviceDefaults.blacklist ? readJson(serviceOptions.blacklist) : null;
      if (blacklist && ipMatch(ip, blacklist)) {
        LOG.CONNECTION_REFUSED && console.log(timestamp(), ipFormatted, '→', hostname, `[CONNECTION_REFUSED_BLACKLISTED] Blacklisted attempted to connect!`);
        return proxyConnection.destroy();
      }

      // Service requires authorization
      if (serviceOptions.auth) {
        if (!serviceOptions.authPassword) {
          LOG.AUTH_ERROR && console.error(timestamp(), ipFormatted, '→', hostname, `[AUTH_REFUSED_MISSING_CONFIG] Error Service misconfigured! Auth is enabled but password is empty!`);
          return proxyConnection.destroy();
        }

        let bypassAuth = false;
        if (serviceOptions.authRemembersIp && realIp) {
          const lastAuthorized = rememberedIps.get(realIp + hostname);
          if (lastAuthorized && (Date.now() - lastAuthorized < serviceOptions.authRemembersIpTtl)) {
            LOG.AUTH_GRANTED && console.log(timestamp(), ipFormatted, '→', hostname, `[AUTH_REMEMBERED] bypassing auth`);
            bypassAuth = true;
          }
          // ip not on rememberlist, just continue with check as normal
        }

        // Check authorization
        if (bypassAuth === false) {

          let authorized = false;
          const authTypes = Array.isArray(serviceOptions.authType) ? serviceOptions.authType : [serviceOptions.authType];
          for (let i = 0; i < authTypes.length; i++) {
            const isLast = i === authTypes.length - 1;
            authorized = checkAuthorization(authTypes[i].toLowerCase(), isLast);
            if (authorized) {
              LOG.AUTH_GRANTED && console.log(timestamp(), ipFormatted, '→', hostname, `[AUTH_GRANTED] Authenticated`);
              // successfully authorized; add to remembered ips
              if (serviceOptions.authRemembersIp && realIp) {
                LOG.AUTH_GRANTED && console.log(timestamp(), ipFormatted, '→', hostname, `[AUTH_REMEMBER] Added to rememberedIps`);
                rememberedIps.set(realIp + hostname, Date.now());
              }
              break;
            }
          }

          // Authorization DENIED!
          if (!authorized) {
            LOG.AUTH_DENIED && console.log(timestamp(), ipFormatted, '→', hostname, `[AUTH_DENIED] Connection refused`);
            return;
          }
        }

      }

      function checkAuthorization(authType, shouldSendFailResp) {

        const simplePass = typeof serviceOptions.authPassword !== "object";
        
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
        

        if (authType === "form" || authType === "cookies") {
          const cookies = parseCookies(getHeader(headers, "Cookie") || "");
          const authCookie = cookies[serviceOptions.authCookie];
          if (testCredentials(serviceOptions, authCookie)) {
            LOG.AUTH_DEBUG && console.log(timestamp(), ipFormatted, '→', hostname, `[AUTH_GRANTED_COOKIE] Authorized via cookie`);
            // Remove cookie before sending to server
            delete cookies[serviceOptions.authCookie];
            setHeader(headers, "Cookie", stringifyCookies(cookies));
            return true;
          }
          if (shouldSendFailResp) {
            LOG.AUTH_DEBUG && console.log(timestamp(), ipFormatted, '→', hostname, `[AUTH_DENIED_COOKIE] Unauthoried. Serving login page`);
            const vars = {
              config: proxyConfig,
              serviceOptions: serviceOptions,
              cookieMaxAge: serviceOptions.cookieMaxAge,
              authCookie: serviceOptions.authCookie,
              hostname,
              ip: realIp || ip,
              simplePass: simplePass,
            };
            const authHtml = formatString(defaultAuthHtmlFile, vars);
            proxyConnection.write(
              `${httpVer} 401 Unauthorized\r\n` +
              `Content-Type: text/html\r\n` +
              `Content-Length: ${authHtml.length}\r\n` +
              `Cache-Control: no-cache, no-store, must-revalidate\r\n` +
              `Pragma: no-cache\r\n` +
              `Expires: 0\r\n` +
              `Service-Worker-Navigation-Preload: true\r\n` +
              `Clear-Site-Data: "cache", "executionContexts"\r\n` +
              `\r\n`+
              `${authHtml}`);
          }
          return false;
        }
        else if (authType === "basic") {
          // Authorize using WWW-Authenticate header
          const authHeader = getHeader(headers, "Authorization") || "";
          const token = authHeader.split(" ")[1] || "";
          const decodedCredentials = Buffer.from(token, "base64").toString();

          if (testCredentials(serviceOptions, decodedCredentials)) {
            LOG.AUTH_DEBUG && console.log(timestamp(), ipFormatted, '→', hostname, `[AUTH_GRANTED_WWW_AUTHENTICATE] Authorized via Authorization header`);
            return true;
          }
          if (shouldSendFailResp) {
            LOG.AUTH_DEBUG && console.log(timestamp(), ipFormatted, '→', hostname, `[AUTH_DENIED_WWW_AUTHENTICATE] Unauthorized`);
            proxyConnection.write(
              `${httpVer} 401 Unauthorized\r\n`+
              `WWW-Authenticate: Basic\r\n`+
              `Content-Length: 0\r\n`+
              `Cache-Control: no-cache, no-store, must-revalidate\r\n` +
              `Pragma: no-cache\r\n` +
              `Expires: 0\r\n` +
              `Service-Worker-Navigation-Preload: true\r\n` +
              `Clear-Site-Data: "cache", "executionContexts"\r\n` +
              `\r\n`);
          }
          return false;
        }
        else if (authType === "custom-header") {
          const header = getHeader(headers, serviceOptions.customAuthHeader);
          
          if (testCredentials(serviceOptions, header)) {
            LOG.AUTH_DEBUG && console.log(timestamp(), ipFormatted, '→', hostname, `[AUTH_GRANTED_HEADER] Authorized via custom header ${serviceOptions.customAuthHeader}`);
            return true;
          }
          if (shouldSendFailResp) {
            LOG.AUTH_DEBUG && console.log(timestamp(), ipFormatted, '→', hostname, `[AUTH_DENIED_HEADER] Unauthorized. Missing header ${serviceOptions.customAuthHeader}`);
            proxyConnection.write(`${httpVer} 401 Unauthorized\r\nContent-Length: 0\r\n\r\n`);
          }
          return false;
        }

        LOG.AUTH_ERROR && console.error(timestamp(), ipFormatted, '→', hostname, `[AUTH_REFUSED_INVALID_CONFIG] Error Service misconfigured! "${authType}" is not a valid authType!`);
        proxyConnection.destroy();
        return false;
      }

      // Is redirect
      if (serviceOptions.redirect) {
        LOG.CONNECTION_INFO && console.log(timestamp(), ipFormatted, '→', hostname, `[REQUEST_REDIRECTED] redirected to ${serviceOptions.redirect}`);
        return proxyConnection.end(`${httpVer} 302 Found\r\nLocation: ${serviceOptions.redirect}\r\n\r\n`);
      }

      // Modify headers
      Object.entries(serviceOptions.modifiedHeaders || {}).forEach(([header, value]) => {
        if (value === true) return;

        if (!value) {
          setHeader(headers, header);
        } else
          setHeader(headers, header, formatString(value, {
            proxyHostname: hostname, // OLD
            serverHostname: serviceOptions.serverHostname, // OLD
            serverPort: serviceOptions.serverPort, // OLD
            hostname,
            serverOptions: serviceOptions,
            headers,
            ip
          }));
      });

      // Is bypassed URI
      // TODO: make this better
      const bypassOptions = serviceOptions.uriBypass?.[uri];
      if (bypassOptions) {
        const bypassHeaders = objectDefaults(bypassOptions.headers, { "Content-Length": bypassOptions.data.length || 0 });
        return proxyConnection.write(`${httpVer} ${bypassOptions.statusCode || 200} ${bypassOptions.statusMessage || ""}\r\n${Object.entries(bypassHeaders).map(i => `${i[0]}: ${i[1]}`).join("\r\n")}\r\n\r\n${bypassOptions.data || ""}`);
      }

      // Reconstruct data
      const reconstructedData = Buffer.concat([
        Buffer.from(`${method} ${serviceOptions.forceUri || uri} ${httpVer}`), // Request line
        Buffer.from("\r\n"), // New line
        Buffer.from(Object.entries(headers).map(i => `${i[0]}: ${i[1]}`).join("\r\n")), // Headers
        Buffer.from("\r\n\r\n"), // New line before data
        Buffer.from(rawData) // Data
      ]);

      // console.log(timestamp(), ipFormatted, '→', hostname, reconstructedData.toString());

      if (!connectionToService) {
        // Connect to server
        LOG.CONNECTION_ACCEPTED && console.log(timestamp(), ipFormatted, '→', hostname, `[SERVICE_CONNECTION_STARTED] connecting to service...`);

        connectionToService = (serviceOptions.useTls ? tls : net).connect({
          host: serviceOptions.serverHostname,
          port: serviceOptions.serverPort,
          rejectUnauthorized: false,
          ...serviceOptions.additionalServerOptions
        });

        // Server events
        connectionToService.on("data", i => writeProxyConnection(i));
        connectionToService.on("close", closeProxyConnection);
        connectionToService.on("end", i => closeProxyConnection);
        connectionToService.on("error", err => {
          LOG.CONNECTION_ERROR && console.error(timestamp(), "[SERVICE_CONNECTION_ERROR]", err);
          closeProxyConnection();
        });

        connectionToService.on("drain", () => proxyConnection.resume());
      }

      writeServerConnection(reconstructedData); // Write changed data if this buffer contains headers
    } else
      writeServerConnection(data); // Write unchanged data if this buffer does not contain headers
  });

  // Proxy events
  proxyConnection.on("close", closeServerConnection);
  proxyConnection.on("end", closeServerConnection);
  proxyConnection.on("error", err => {
    LOG.PROXY_ERROR && console.error(timestamp(), `🖥 ${ip}`, "[PROXY_SERVER_ERROR]", err);
    closeServerConnection();
  });
  proxyConnection.on("drain", () => connectionToService?.resume());

  function closeServerConnection() { if (connectionToService && !connectionToService.ended) connectionToService.end() }
  function closeProxyConnection() { if (proxyConnection && !proxyConnection.ended) proxyConnection.end() }
  function writeServerConnection(data) { if (connectionToService && !connectionToService.ended) if (!connectionToService.write(data)) proxyConnection.pause() }
  function writeProxyConnection(data) { if (proxyConnection && !proxyConnection.ended) if (!proxyConnection.write(data)) connectionToService.pause() }
}

function shutdownProxy() {
  LOG.PROXY_INFO && console.log(timestamp(), "[PROXY_SHUTDOWN] Shutting down proxy...");
  proxyServer.close();
  services.unwatch();
  fw.unwatchAll();
  LOG.PROXY_INFO && console.log(timestamp(), "[PROXY_SHUTDOWN] Stopped.");
  process.exit(0);
}

main();
