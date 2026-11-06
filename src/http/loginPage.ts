export function renderLoginPage(state: { failed: boolean; limited: boolean; unconfigured: boolean }): string {
  const message = state.unconfigured
    ? "Set SCYTH3D_UI_PASSWORD on the server before anyone can sign in."
    : state.limited
      ? "Too many attempts. Wait a few minutes and try again."
      : state.failed
        ? "That password is not right."
        : "Sign in to slice and quote. Bots keep using the API key.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · BlackCat Scyth3d</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: #0c0d10; color: #f4f0e8;
      font: 16px/1.45 ui-sans-serif, "Segoe UI", sans-serif;
      padding: 24px;
    }
    form {
      width: min(420px, 100%);
      background: #16181d;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 18px;
      padding: 28px 24px 24px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.35);
    }
    .mark { display: flex; gap: 10px; align-items: center; }
    .ears { width: 28px; height: 22px; }
    h1 { font: 600 28px/1.1 Palatino, "Iowan Old Style", Georgia, serif; margin: 14px 0 4px; letter-spacing: -0.03em; }
    p { margin: 0 0 18px; color: #b7b1a6; }
    label { display: block; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; color: #d8b06a; margin-bottom: 8px; }
    input {
      width: 100%; padding: 14px 12px; border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.12); background: #0e1014; color: inherit; font: inherit;
    }
    button {
      margin-top: 16px; width: 100%; border: 0; border-radius: 12px; padding: 14px;
      background: #e0a44a; color: #1a1206; font: 650 16px/1 ui-sans-serif, sans-serif; cursor: pointer;
    }
    .note { margin-top: 14px; font-size: 13px; color: #8f897f; }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <div class="mark">
      <svg class="ears" viewBox="0 0 28 22" aria-hidden="true"><path fill="#e0a44a" d="M4 20 L8 4 L14 16 Z M24 20 L20 4 L14 16 Z"/></svg>
      <span>BlackCat MakerLab</span>
    </div>
    <h1>Scyth3d</h1>
    <p>${message}</p>
    <label for="password">Lab password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Enter the slicer</button>
    <p class="note">The browser never sees the API key. MCP bots still use their own token.</p>
  </form>
</body>
</html>`;
}

export function renderUiMissingPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>BlackCat Scyth3d</title></head>
<body style="background:#0c0d10;color:#f4f0e8;font:16px ui-sans-serif,sans-serif;padding:32px">
<p>The browser UI has not been built. From the repo, run <code>npm run build</code>.</p>
</body></html>`;
}
