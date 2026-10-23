# Remote access

The default endpoint is local to the machine running the extension host. The extension does not install a tunnel, publish a public URL, or configure a cloud account.

## Compatibility

A local client needs MCP Streamable HTTP support and the ability to send an `Authorization: Bearer …` header. A remote client also needs access to a user-managed HTTPS endpoint. Client configuration formats vary; use the configuration copied by the extension as the source of the current URL and token.

This release does not implement an OAuth authorization server. A hosted connector that requires OAuth or cannot send custom bearer headers may be incompatible. Do not treat a successful browser request as proof that a particular AI product supports this server.

## Required forwarding boundaries

If you choose to publish a remote endpoint:

1. Keep the extension listener bound to loopback. Place the TLS reverse proxy or tunnel on the same extension-host machine, or use a secure route to that machine's loopback endpoint.
2. Use a dedicated hostname with a valid HTTPS certificate on port 443. Set `workspaceBridge.allowedHosts` to the exact hostname used by the proxy, such as `["bridge.example.com"]`. Do not include a scheme, port, or wildcard.
3. Preserve the `Authorization` header, MCP protocol headers, session headers, and the `/mcp` endpoint. Preserve the request streaming behavior required by the client. Do not cache MCP responses.
4. Require the extension's bearer token on every request. Add access controls at the proxy when practical. Do not embed tokens in URLs, source control, public client examples, or public proxy configuration.
5. Disable request-body and authorization-header logging. Decide separately what your proxy, hosting provider, and client retain.
6. Keep editing and terminal execution disabled until needed. Remain at the VS Code machine to review each terminal request.
7. Replace the copied client configuration's local URL with `https://bridge.example.com/mcp`, keeping the bearer header. Test denied requests as well as a successful read with disposable data. Stop forwarding and rotate the token if the endpoint or token was shared unintentionally.

Allowlisting a host validates the HTTP host value; it is not client authentication or a network firewall. TLS protects transport to the proxy and does not limit what an authorized client can request. Bearer tokens provide no per-client scopes or identities in this release.

## Multi-window routing

Each running extension instance owns its own endpoint, active workspace identity, and bearer token. Two windows opening the same folder do not share a token. Reloading or reopening a window creates a new token; stopping and restarting the bridge within the same window activation reuses its token. Copy the configuration again after reloading, rotating credentials, or changing workspaces.

When a preferred port is occupied, the extension tries the next nine ports; use `workspaceBridge.port: 0` to request an automatically assigned port. Confirm the actual endpoint after starting. Do not route a shared public hostname to whichever editor window happens to be focused. Pin a forwarder to the intended instance and confirm its workspace identity before enabling writes.

## VS Code Remote, WSL, containers, and SSH

“Local” refers to the machine or environment running the extension host. In a remote workspace, that may be a remote server or container rather than the desktop computer. Verify the endpoint location and the workspace shown in the control panel before forwarding it. These environments require separate acceptance tests; they are not covered merely by testing desktop Windows.

## Revoke access

Stop the bridge to end the session, remove the forwarding route, rotate the token, and replace saved client configurations as needed. Rotation cannot recall data that a client already received. Clear sensitive clipboard content and review whether your clipboard manager keeps history.
