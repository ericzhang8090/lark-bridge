'use strict';

// All subprocesses use the bridge's existing isolated childEnv(). No credentials
// or external error payloads are returned to logs by this module.
async function checkCodexStartup({ larkExe, codexExe, profile, mcpAvailable, run }) {
  const issue = (code, message) => ({ ok: false, issues: [{ code, message }] });
  if (!larkExe) return issue('lark_missing', '找不到 Lark CLI，请安装 @larksuite/cli 或设置 larkCliExe。');
  if (!codexExe) return issue('codex_missing', '找不到 Codex CLI，请安装 Codex 或设置 codexExe。');
  if (!mcpAvailable) return issue('mcp_missing', '缺少 lark-mcp.js，请重新部署完整版本。');

  let lark;
  try {
    lark = await run(larkExe, ['auth', 'status', '--json'], { timeoutMs: 30000 });
  } catch {
    return issue('lark_status_failed', '无法检查 Lark 登录状态，请运行 start.ps1 -Check。');
  }
  let status;
  try { status = JSON.parse((lark.stdout || lark.stderr || '').replace(/^\uFEFF/, '').trim()); }
  catch { return issue('lark_invalid_status', 'Lark CLI 状态格式无效，请运行 start.ps1 -Check。'); }
  if (status?.error?.type === 'config' && status.error.subtype === 'not_configured') {
    return issue('lark_not_configured', `Lark 配置 ${profile || '（默认）'} 尚未建立。请按 DEPLOY-CODEX.md 绑定独立应用；不会自动改用其他机器人的配置。`);
  }
  if (lark.code !== 0 || status?.ok === false || !status?.identities?.bot?.available) {
    return issue('lark_not_ready', 'Lark 应用身份未就绪，请检查所选应用配置、凭据和权限后重新运行 start.ps1 -Check。');
  }
  let codex;
  try {
    codex = await run(codexExe, ['login', 'status'], { timeoutMs: 30000 });
  } catch {
    return issue('codex_status_failed', '无法检查 Codex 登录状态，请运行 codex-login.ps1。');
  }
  const text = `${codex.stdout || ''}\n${codex.stderr || ''}`;
  if (codex.code !== 0 || !/\blogged in\b/i.test(text) || /\bnot logged in\b/i.test(text)) {
    return issue('codex_not_logged_in', '机器人专用的 Codex 尚未登录，请运行 codex-login.ps1。桌面聊天和机器人会话各自独立。');
  }
  return { ok: true, issues: [] };
}

module.exports = { checkCodexStartup };
