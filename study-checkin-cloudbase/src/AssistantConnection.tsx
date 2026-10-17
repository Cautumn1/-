import { useEffect, useRef, useState } from "react";
import { callStudyApi } from "./cloudbase";

type Connection = { configured: boolean; connected: boolean; mcpUrl?: string; setupFingerprint?: string };

function authorizationRequest(): Record<string, string> | null {
  const raw = new URLSearchParams(window.location.search).get("assistant_authorize");
  if (!raw) return null;
  try {
    if (raw.length > 6000) throw new Error();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.values(parsed).some((value) => typeof value !== "string")) throw new Error();
    return parsed as Record<string, string>;
  } catch { throw new Error("授权链接不完整，请从ChatGPT插件重新连接。"); }
}

export default function AssistantConnection({ token, name, onClose }: {
  token: string; name: string; onClose: () => void;
}) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const [request] = useState(() => {
    try { return { authorization: authorizationRequest(), error: "" }; }
    catch (error) { return { authorization: null, error: (error as Error).message }; }
  });

  async function cancel() {
    if (!request.authorization || !connection?.configured || token !== "user1") { onClose(); return; }
    setBusy(true);
    try {
      const result = await callStudyApi<{ redirectUrl: string }>("denyAssistant", { token, authorization: request.authorization });
      returnToChatGPT(result.redirectUrl);
    } catch { setBusy(false); onClose(); }
  }

  function returnToChatGPT(redirectUrl: string) {
    const target = new URL(redirectUrl);
    if (target.origin !== "https://chatgpt.com"
      || !(/^\/connector\/oauth\/[a-zA-Z0-9_-]+$/.test(target.pathname)
        || target.pathname === "/connector_platform_oauth_redirect")) throw new Error("授权回调地址无效");
    window.location.assign(target.href);
  }

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => { previous?.focus(); };
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) void cancel();
      if (event.key !== "Tab") return;
      const controls = dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), a[href]");
      if (!controls?.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [busy, onClose, connection?.configured, request.authorization, token]);

  useEffect(() => {
    if (token !== "user1") return;
    let cancelled = false;
    callStudyApi<Connection>("getAssistantConnection", { token }).then((result) => {
      if (!cancelled) setConnection(result);
    }).catch((error: unknown) => {
      if (!cancelled) { setConnection({ configured: false, connected: false }); setMessage(error instanceof Error ? error.message : "暂时无法读取连接状态"); }
    });
    return () => { cancelled = true; };
  }, [token]);

  async function authorize() {
    if (!request.authorization || !connection?.configured || token !== "user1") return;
    setBusy(true); setMessage("");
    try {
      const result = await callStudyApi<{ redirectUrl: string }>("authorizeAssistant", {
        token, authorization: request.authorization,
      });
      returnToChatGPT(result.redirectUrl);
    } catch (error) { setMessage(error instanceof Error ? error.message : "授权失败"); setBusy(false); }
  }

  async function revoke() {
    setBusy(true); setMessage("");
    try {
      await callStudyApi("revokeAssistant", { token });
      setConnection((current) => current ? { ...current, connected: false } : current);
      setMessage("连接已撤销，ChatGPT无法再读取或修改计划。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "撤销失败，请重试"); }
    finally { setBusy(false); }
  }

  async function copyUrl() {
    if (!connection?.mcpUrl) return;
    try { await navigator.clipboard.writeText(connection.mcpUrl); setMessage("连接地址已复制。"); }
    catch { setMessage("复制未成功，请选中上方连接地址后复制。"); }
  }

  const scope = request.authorization?.scope || "study:read study:write";
  return (
    <div className="modal-backdrop">
      <section ref={dialog} className="login-card assistant-connection" role="dialog" aria-modal="true" aria-labelledby="assistant-heading">
        <div className="editor-heading">
          <div><span>学习计划助手</span><h2 id="assistant-heading">{request.authorization ? "授权ChatGPT连接" : "连接ChatGPT"}</h2></div>
          <button ref={closeButton} onClick={() => void cancel()} disabled={busy} aria-label="关闭连接窗口">×</button>
        </div>
        {token !== "user1" ? <p>当前身份为{name}，此连接仅支持蔡。请关闭窗口，切换为蔡后从ChatGPT重新连接。</p> : <>
          <p>让ChatGPT读取蔡的实际学习进度，并在你要求时调整和保存计划。</p>
          <ul className="assistant-permissions">
            <li>读取蔡的任务、完成状态和学习时长。</li>
            {scope.split(" ").includes("study:write") && <li>编辑含今天在内的7天计划，保留已完成、自习中和已有学习时长的任务。</li>}
            <li>不会替你打卡、操作自习计时或修改刘的计划。</li>
          </ul>
          {request.error ? <p className="form-error" role="alert">{request.error}</p>
            : !connection ? <p>正在读取连接状态…</p>
            : !connection.configured ? <>
              <p className="form-error">此浏览器尚未完成连接设置。请保留本网站的登录状态，由维护者完成绑定。</p>
              {connection.setupFingerprint && <label className="assistant-url"><span>接入标识（供维护者绑定此浏览器）</span><input aria-label="浏览器接入标识" readOnly value={connection.setupFingerprint} /></label>}
            </>
            : request.authorization ? <>
              <p>仅在你刚从ChatGPT发起连接时授权。可随时回到网站撤销；重新连接将替换此前的连接。</p>
              <button className="primary-button" onClick={authorize} disabled={busy}>{busy ? "正在授权…" : "允许连接蔡的学习计划"}</button>
              <button className="secondary-button" onClick={() => void cancel()} disabled={busy}>取消</button>
            </> : <>
              <p className="assistant-status">{connection.connected ? "已连接，可在ChatGPT中读取和调整计划。" : "尚未连接。完成以下设置即可使用。"}</p>
              <label className="assistant-url"><span>连接地址</span><input aria-label="ChatGPT连接地址" readOnly value={connection.mcpUrl || ""} /></label>
              <button className="secondary-button" onClick={copyUrl}>复制连接地址</button>
              <ol className="assistant-permissions">
                <li>在ChatGPT的“插件”中选择“添加自定义MCP服务器”。</li>
                <li>名称填写“自习计划”，粘贴连接地址，认证选择OAuth。</li>
                <li>连接时回到本网站，确认授权给蔡；然后在学习计划对话中选择这个插件。</li>
              </ol>
              {connection.connected && <button className="danger-button" onClick={revoke} disabled={busy}>{busy ? "正在撤销…" : "撤销ChatGPT连接"}</button>}
            </>}
        </>}
        {message && <p className="assistant-message" role="status">{message}</p>}
      </section>
    </div>
  );
}
