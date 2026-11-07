const FONTS = `
@font-face { font-family: "Chakra Petch"; font-style: italic; font-weight: 700; src: url("/brand/fonts/chakra-petch-700-italic.ttf") format("truetype"); }
@font-face { font-family: "Chakra Petch"; font-style: normal; font-weight: 600; src: url("/brand/fonts/chakra-petch-600.ttf") format("truetype"); }
@font-face { font-family: Rajdhani; font-style: normal; font-weight: 500; src: url("/brand/fonts/rajdhani-500.ttf") format("truetype"); }
`;

export function renderLoginPage(state: { failed: boolean; limited: boolean; unconfigured: boolean }): string {
  const error = state.unconfigured
    ? "Sign-in is not configured."
    : state.limited
      ? "Too many attempts. Wait a few minutes."
      : state.failed
        ? "That password is not right."
        : "";
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
      font-weight: 500; font-size: 18px;
      padding: 24px 16px;
    }
    form {
      width: min(380px, 100%);
      background: #141414;
      border: 1px solid #2A2410;
      padding: 28px 24px 24px;
      display: grid;
      gap: 16px;
    }
    .logo { width: min(220px, 100%); height: auto; display: block; }
    h1 {
      margin: 0;
      font-family: "Chakra Petch", "Arial Narrow", Arial, Helvetica, sans-serif;
      font-weight: 700; font-style: italic; font-size: 28px; line-height: 1;
      text-transform: uppercase; color: #F5F2E9;
    }
    label {
      display: grid; gap: 8px;
      font-family: "Chakra Petch", "Arial Narrow", Arial, Helvetica, sans-serif;
      font-weight: 600; font-size: 14px; letter-spacing: 0.12em; text-transform: uppercase;
      color: #EB008B;
    }
    input {
      width: 100%; padding: 12px; border: 1px solid #2A2410; background: #0A0A0A; color: #F5F2E9;
      font: 500 18px/1.2 Rajdhani, "Segoe UI", Arial, Helvetica, sans-serif;
    }
    .error {
      margin: 0; min-height: 1.2em;
      color: #F5F2E9; font-size: 16px;
    }
    .error:empty { display: none; }
    button {
      border: 0; padding: 14px 16px; background: #EB008B; color: #FFFFFF; cursor: pointer;
      font-family: "Chakra Petch", "Arial Narrow", Arial, Helvetica, sans-serif;
      font-weight: 700; font-size: 18px; letter-spacing: 0.04em; text-transform: uppercase;
    }
    @media (max-width: 480px) {
      body { padding: 16px; }
      form { padding: 22px 16px 18px; }
      h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <img class="logo" src="/brand/logos/blackcat-makerlab-dark-outline_transparent@2x.png" width="220" alt="BlackCat MakerLab">
    <h1>Sign in</h1>
    <label>Password
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    </label>
    <p class="error" role="alert">${error}</p>
    <button type="submit">Sign in</button>
  </form>
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
