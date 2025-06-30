📡 Reverse Proxy
===================
> NOTE: You should use [Nginx](https://www.nginx.com) for anything serious!

This lightweight HTTP reverse proxy routes requests based on the host header.
For example: `plex.yourdomain.com` → `localhost:32400`

### Why Use This?
- Manage multiple services on your local network easily.
- Only port forward a single port on your router.
- Access each service using different domains or subdomains—no more typing ports!
- No dependencies—just install and run!
- Simple setup in under 1 minute.
- Pre-configured to work with Cloudflare for:
    - Extra security with Cloudflare's default protection.
    - Free HTTPS encryption for your services.
    - Hiding your actual server's IP address.
    - Blocking unwanted bots.

## ✨ Key Features
* __User Authentication__: Web form login (Cookies), Basic Auth (WWW-Authenticate), or custom headers.
* __IP Access Control__: Whitelist or blacklist specific IP ranges.
* __Smart Routing__: Skip rules for certain URIs.
* __Custom Redirects__: Add flexible redirects for your needs.
* __Per-Service Settings__: Configure each service independently.
* __Hot Reload__: Update configurations without restarting the proxy.


# 🛠️ How to Get Started

1. Install the Proxy Make sure [Node.js](https://nodejs.org/) is installed, then run:
    ```sh
    npm install -g https://github.com/victornpb/HTTP-Reverse-Proxy.git
    ```

2. Create a folder for containing your proxy files
    ```sh
    mkdir myproxy # you can name it anything you want
    cd myproxy
    ```

3. Create a new server
    ```sh
    reverseproxy create
    ```

4. Customize you proxy editing files  
  *(for instructions check [readme](./example/) inside your folder)*

5. Start the proxy  
    ```sh
    # Just run this commmand inside your proxy folder
    reverseproxy start
    ```

----

Credits to [Lyall A](https://github.com/Lyall-A/HTTP-Reverse-Proxy), which this fork is based on
