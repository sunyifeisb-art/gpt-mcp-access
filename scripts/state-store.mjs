// 持久化 OAuth client + token store（JSON 文件，重启不丢）
// 解决"桥接重启 → in-memory client/token 丢失 → invalid_client / 需要重授权"。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export function createPersistentOAuthStores(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "oauth.json");
  let data = { clients: {}, access: {}, refresh: {} };
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch {}
  const flush = () => { try { writeFileSync(file, JSON.stringify(data)); } catch {} };
  // 同步写：低频单用户，立即落盘最稳（防抖会在快速重启时丢数据）

  const clientsStore = {
    getClient(id) { return data.clients[id]; },
    registerClient(c) { data.clients[c.client_id] = c; flush(); return c; },
  };
  const tokenStore = {
    saveTokenPair({ accessTokenHash, accessToken, refreshTokenHash, refreshToken }) {
      data.access[accessTokenHash] = accessToken;
      data.refresh[refreshTokenHash] = refreshToken;
      flush();
      return true;
    },
    getAccessToken(h) { return data.access[h]; },
    getRefreshToken(h) { return data.refresh[h]; },
    deleteAccessToken(h) { delete data.access[h]; flush(); },
    deleteRefreshToken(h) { delete data.refresh[h]; flush(); },
    close() { flush(); },
  };
  return { clientsStore, tokenStore };
}
