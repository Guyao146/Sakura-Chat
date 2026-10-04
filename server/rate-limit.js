'use strict';

/**
 * 登录/注册限流：固定窗口的失败/请求计数，超阈值后短期锁定。
 *
 * 设计要点（与 oauth.js 的票据表一致的风格）：
 * - 纯内存、惰性清理 + 硬上限，防 Map 无限增长
 * - lockSec 窗口过期后自动放行，窗口内的重复命中不续期，避免「一直被刷就一直锁」
 * - clock 可注入，便于单元测试推进时间
 *
 * 部署注意：clientIp 使用 Express 按 TRUST_PROXY 白名单解析后的 req.ip。
 * 默认不信任代理头。只配置实际代理的 IP/CIDR，代理必须覆盖转发头。
 * 新键突发超过硬上限时仍会逐出最旧键，这是内存保护的有意取舍。
 */

function createLimiter({ maxFails = 5, lockSec = 60, maxKeys = 5000, clock = Date.now } = {}) {
  const attempts = new Map();   // 插入顺序即窗口起始顺序，命中不续期/不移动键
  const windowMs = lockSec * 1000;

  function current(key, t) {
    const rec = attempts.get(key);
    if (rec && t - rec.first >= windowMs) { attempts.delete(key); return null; }
    return rec;
  }

  return {
    /** 命中一次；仅插入新键时回收容量，已有键不能被意外逐出 */
    hit(key) {
      const t = clock();
      const rec = current(key, t);
      if (rec) { rec.count += 1; return; }
      // 固定窗口 + Map 插入顺序：只扫描已过期的前缀，无需全表扫描/排序。
      for (const [k, v] of attempts) {
        if (t - v.first < windowMs) break;
        attempts.delete(k);
      }
      if (attempts.size >= maxKeys) attempts.delete(attempts.keys().next().value);
      attempts.set(key, { count: 1, first: t });
    },
    /** 查询为 O(1)，表满时也绝不逐出有效键 */
    tooMany(key) {
      const rec = current(key, clock());
      return !!rec && rec.count >= maxFails;
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

/** 客户端 IP：只使用经过 Express 信任代理策略解析的地址 */
function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || '?';
}

/** 登录限流键：ip + 用户名（小写），不同账号各自计数，仅按 IP 锁定会被代理后误伤 */
function loginKey(req, username) {
  return clientIp(req) + '|' + String(username || '').toLowerCase();
}

module.exports = { createLimiter, loginLimiter, registerLimiter, clientIp, loginKey };
