const FONTS = `
@font-face { font-family: "Chakra Petch"; font-style: italic; font-weight: 700; src: url("/brand/fonts/chakra-petch-700-italic.ttf") format("truetype"); }
@font-face { font-family: "Chakra Petch"; font-style: normal; font-weight: 600; src: url("/brand/fonts/chakra-petch-600.ttf") format("truetype"); }
@font-face { font-family: Rajdhani; font-style: normal; font-weight: 500; src: url("/brand/fonts/rajdhani-500.ttf") format("truetype"); }
@font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 400; src: url("/brand/fonts/jetbrains-mono-400.ttf") format("truetype"); }
`;

export function renderLoginPage(state: { failed: boolean; limited: boolean; unconfigured: boolean }): string {
  const message = state.unconfigured
    ? "Set SCYTH3D_UI_PASSWORD on the server before anyone can sign in."
    : state.limited
      ? "Too many attempts. Wait a few minutes and try again."
      : state.failed
        ? "That password is not right."
        : "Sign in to slice and quote.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · BlackCat MakerLab</title>
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" href="/brand/favicon-32.png">
  <style>
    ${FONTS}
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: #0A0A0A; color: #F5F2E9;
      font-family: Rajdhani, "Segoe UI", Arial, Helvetica, sans-serif;
      font-weight: 500; font-size: 18px; line-height: 1.45;
      padding: 32px 20px;
    }
    main { width: min(440px, 100%); display: grid; gap: 18px; }
    .logo { width: min(300px, 100%); height: auto; }
    form {
      background: #141414; border: 1px solid #2A2410; padding: 28px 24px 22px;
    }
    .eyebrow {
      margin: 0 0 8px;
      font-family: "Chakra Petch", "Arial Narrow", Arial, Helvetica, sans-serif;
      font-weight: 600; font-size: 14px; letter-spacing: 4px; text-transform: uppercase;
      color: #EB008B;
    }
    h1 {
      margin: 0 0 8px;
      font-family: "Chakra Petch", "Arial Narrow", Arial, Helvetica, sans-serif;
      font-weight: 700; font-style: italic; font-size: 32px; line-height: 1;
      letter-spacing: 0.02em; text-transform: uppercase; color: #F5F2E9;
    }
    p { margin: 0 0 18px; color: #B8B4A8; }
    label {
      display: block; margin-bottom: 8px;
      font-family: "Chakra Petch", "Arial Narrow", Arial, Helvetica, sans-serif;
      font-weight: 600; font-size: 14px; letter-spacing: 4px; text-transform: uppercase;
      color: #EB008B;
    }
    input {
      width: 100%; padding: 12px; border: 1px solid #2A2410; background: #0A0A0A; color: #F5F2E9;
      font: 500 18px/1.2 Rajdhani, "Segoe UI", Arial, Helvetica, sans-serif;
    }
    button {
      margin-top: 16px; width: 100%; border: 0; padding: 14px 16px;
      background: #EB008B; color: #FFFFFF; cursor: pointer;
      font-family: "Chakra Petch", "Arial Narrow", Arial, Helvetica, sans-serif;
      font-weight: 700; font-size: 18px; letter-spacing: 0.04em; text-transform: uppercase;
    }
    .note { margin: 14px 0 0; color: #8A8676; font-size: 16px; }
    footer { color: #8A8676; font-size: 14px; display: grid; gap: 6px; }
    footer img.mark { width: 160px; height: auto; }
    footer .social { display: flex; gap: 10px; }
    footer .social img { width: 24px; height: 24px; }
    footer a { color: #EB008B; }
  </style>
</head>
<body>
  <main>
    <img class="logo" src="/brand/logos/blackcat-makerlab-dark-outline_transparent@2x.png" width="300" alt="BlackCat MakerLab">
    <form method="post" action="/login">
      <p class="eyebrow">3D printing &amp; fabrication</p>
      <h1>Sign in</h1>
      <p>${message}</p>
      <label for="password">Lab password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Enter the slicer</button>
      <p class="note">The browser never sees the API key. MCP clients still use their own token.</p>
    </form>
    <footer>
      <img class="mark" src="/brand/logos/blackcat-logo-reverse_transparent@2x.png" width="160" alt="BlackCat">
      <div>MakerLab — 3D printing &amp; fabrication · a BlackCat lab</div>
      <div>blackcat.eu.com · labs@blackcat.eu.com · +356 9921 4462</div>
      <div>BlackCat Studios 71, First Floor, Triq l-Imdina, QRM9019, Malta</div>
      <div>VAT MT31422627</div>
      <div class="social">
        <a href="https://instagram.com/blackcat.makerlab"><img src="/brand/icons/instagram-pink@2x.png" width="24" height="24" alt="Instagram"></a>
        <a href="https://facebook.com/blackcat.makerlab"><img src="/brand/icons/facebook-pink@2x.png" width="24" height="24" alt="Facebook"></a>
      </div>
    </footer>
  </main>
</body>
</html>`;
}

export function renderUiMissingPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>BlackCat MakerLab Slicer</title></head>
<body style="background:#0A0A0A;color:#F5F2E9;font:18px Rajdhani,Segoe UI,Arial,sans-serif;padding:32px">
<p>The browser has not been built. From the repo, run <code>npm run build</code>.</p>
</body></html>`;
}
