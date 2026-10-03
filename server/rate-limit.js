'use strict';

/**
 * 登录/注册限流：固定窗口的失败/请求计数，超阈值后短期锁定。
 *
 * 设计要点（与 oauth.js 的票据表一致的风格）：
 * - 纯内存、惰性清理 + 硬上限，防 Map 无限增长
 * - lockSec 窗口过期后自动放行，窗口内的重复命中不续期，避免「一直被刷就一直锁」
 * - clock 可注入，便于单元测试推进时间
 *
 * 部署注意：clientIp 信任 X-Forwarded-For 首段（与 OAuth 回调地址推断一致）。
 * 反向代理务必覆盖该头（Nginx: proxy_set_header X-Forwarded-For $remote_addr;），
 * 否则同一代理后的用户共享计数；直连暴露端口时该头可被伪造，应保证仅代理可访问。
 */

function createLimiter({ maxFails = 5, lockSec = 60, maxKeys = 5000, clock = Date.now } = {}) {
  const attempts = new Map();   // key -> { count, first }

  /**
   * 惰性清理：先删过期键，超硬上限时按窗口起始时间逐出最旧的键。
   * 注意：突发的大量新键可能逐出仍在锁定中的旧键（提前解锁），
   * 这是有意为之——内存占用有界比单个键的锁状态更重要（默认 maxKeys=5000，正常使用不会触及）。
   */
  function prune() {
    if (attempts.size === 0) return;
    const t = clock();
    if (attempts.size > 64) {
      for (const [k, v] of attempts) if (t - v.first >= lockSec * 1000) attempts.delete(k);
    }
    if (attempts.size >= maxKeys) {
      // 逐出至 maxKeys-1，使随后的插入恰好不超过上限
      const oldest = [...attempts].sort((a, b) => a[1].first - b[1].first);
      for (let i = 0; i < oldest.length && attempts.size >= maxKeys; i++) attempts.delete(oldest[i][0]);
    }
  }

  return {
    /** 命中一次（窗口过期则重开新窗口） */
    hit(key) {
      prune();
      const t = clock();
      const rec = attempts.get(key);
      if (!rec || t - rec.first >= lockSec * 1000) attempts.set(key, { count: 1, first: t });
      else rec.count += 1;
    },
    /** 是否已锁定 */
    tooMany(key) {
      prune();
      const rec = attempts.get(key);
      return !!rec && rec.count >= maxFails && clock() - rec.first < lockSec * 1000;
    },
    /** 成功后清零（登录专用：只记失败，成功即解锁） */
    clear(key) { attempts.delete(key); },
    /** 测试与运维用：清空全部计数 */
    reset() { attempts.clear(); },
    /** 当前跟踪的键数量（观测内存占用） */
    get size() { return attempts.size; },
  };
}

/** 登录限流：key = ip|用户名（小写），失败 5 次锁 60 秒 */
const loginLimiter = createLimiter({ maxFails: 5, lockSec: 60 });
/** 注册限流：key = ip，成功也计入配额，每小时 10 次 */
const registerLimiter = createLimiter({ maxFails: 10, lockSec: 3600 });

/** 客户端 IP：X-Forwarded-For 首段优先，其次 socket 地址 */
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (fwd) return fwd;
  return req.ip || (req.socket && req.socket.remoteAddress) || '?';
}

/** 登录限流键：ip + 用户名（小写），不同账号各自计数，仅按 IP 锁定会被代理后误伤 */
function loginKey(req, username) {
  return clientIp(req) + '|' + String(username || '').toLowerCase();
}

module.exports = { createLimiter, loginLimiter, registerLimiter, clientIp, loginKey };
