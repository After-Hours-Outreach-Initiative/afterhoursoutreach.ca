# Deployment

- Domain: [afterhoursoutreach.ca](https://afterhoursoutreach.ca)
- DNS registrar: Porkbun
- DNS manager: Cloudflare DNS
- Hosting: Cloudflare Worker named `afterhoursoutreach-ca`
- Codebase:
  https://github.com/After-Hours-Outreach-Initiative/afterhoursoutreach.ca

We plan to replace Wrangler with Cloudflare's `cf` CLI once its beta ends, as
outlined in
[Cloudflare's announcement](https://blog.cloudflare.com/cloudflare-cf-cli-launch/).
