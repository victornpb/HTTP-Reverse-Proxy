# Reverse Proxy Configuration

Steps to Setup
---------------------

1. Edit Configuration Files
   - Edit global proxy settings editing `config.json`
   - Add IP ranges to `ip-whitelist.conf` and `ip-blacklist.conf`

2. Create services
   - Edit the defaults editing `_defaults.json`
   - Add files inside the `/services` folder

3. Start the Proxy Server
   - Run the proxy server using the cli command  
    ` $ reverseproxy start `


config.json
--------------------
Global proxy configuration. Customize the following settings in `config.json`:

- **Port**: Set the listening port for the proxy server (default: 80).
- **Hostname**: Specify the server hostname (default: null).
- **TLS**: Enable HTTPs by providing paths to `key` and `cert` files.
- **Whitelist**: Set the path to `ip-whitelist.conf` for allowed IPs.
- **Blacklist**: Optionally set the path to `ip-blacklist.conf` to block IPs.

Services
---------
Create a JSON file in the `/services` folder for each service you want to expose.

See readme in the services folder for more details.


IP Blocking
------------

You can allow / disallow IPs using whitelist and blacklists

