import cloudbase from "@cloudbase/js-sdk";

const env = import.meta.env.VITE_CLOUDBASE_ENV_ID as string | undefined;
const region = (import.meta.env.VITE_CLOUDBASE_REGION as string | undefined) ?? "ap-shanghai";
const accessKey = import.meta.env.VITE_CLOUDBASE_ACCESS_KEY as string | undefined;

if (!env || !accessKey) {
  throw new Error("缺少 CloudBase 生产环境配置");
}

const app = cloudbase.init({
  env,
  region,
  accessKey,
  auth: { detectSessionInUrl: true },
});
let authPromise: Promise<void> | null = null;

async function ensureAnonymousAuth() {
  if (!authPromise) {
    authPromise = (async () => {
      const session = await app.auth.getSession();
      if (session.error) throw new Error(session.error.message || "CloudBase 登录状态检查失败");
      if (session.data?.session) return;

      const signedIn = await app.auth.signInAnonymously();
      if (signedIn.error) throw new Error(signedIn.error.message || "CloudBase 匿名登录失败");
    })().catch((error) => {
      authPromise = null;
      throw error;
    });
  }
  await authPromise;
}

type FunctionEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };

export async function callStudyApi<T>(action: string, payload: Record<string, unknown> = {}) {
  await ensureAnonymousAuth();
  const response = await app.callFunction({
    name: "study-checkin-api",
    data: { action, ...payload },
  }) as unknown as { code?: string; message?: string; result?: FunctionEnvelope<T> };
  if (response.code) throw new Error(response.message || "云函数调用失败");

  const result = response.result as FunctionEnvelope<T> | undefined;
  if (!result) throw new Error("云函数没有返回数据");
  if (!result.ok) throw new Error(result.error || "操作失败");
  return result.data;
}
