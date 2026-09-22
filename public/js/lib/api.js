/** HTTP API 客户端 */

const BASE = '/api';
let token = null;

export function setToken(t) { token = t; }
export function getToken() { return token; }

export async function request(method, path, body) {
  const opts = { method, headers: {} };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = { error: text }; }
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) {
      localStorage.removeItem('sc_token');
    }
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

export const api = {
  // 账号
  register: (b) => request('POST', '/auth/register', b),
  login: (b) => request('POST', '/auth/login', b),
  session: () => request('GET', '/auth/session'),
  me: () => request('GET', '/auth/me'),
  // 用户
  searchUsers: (q) => request('GET', `/users/search?q=${encodeURIComponent(q)}`),
  getUser: (id) => request('GET', `/users/${id}`),
  updateProfile: (b) => request('PUT', '/users/profile', b),
  // 好友
  friends: () => request('GET', '/friends'),
  requests: () => request('GET', '/friends/requests'),
  addFriend: (b) => request('POST', '/friends/request', b),
  acceptRequest: (id) => request('POST', `/friends/requests/${id}/accept`),
  rejectRequest: (id) => request('POST', `/friends/requests/${id}/reject`),
  deleteFriend: (id) => request('DELETE', `/friends/${id}`),
  // 群组
  groups: () => request('GET', '/groups'),
  group: (id) => request('GET', `/groups/${id}`),
  createGroup: (b) => request('POST', '/groups', b),
  inviteMembers: (id, b) => request('POST', `/groups/${id}/members`, b),
  removeMember: (gid, uid) => request('DELETE', `/groups/${gid}/members/${uid}`),
  dismissGroup: (id) => request('POST', `/groups/${id}/dismiss`),
  // 会话与消息
  conversations: () => request('GET', '/conversations'),
  messages: (convId, before) => request('GET', `/conversations/${convId}/messages${before ? `?before=${before}` : ''}`),
  markRead: (convId) => request('POST', `/conversations/${convId}/read`),
  searchHistory: (convId, q) => request('GET', `/conversations/${convId}/search?q=${encodeURIComponent(q)}`),
  searchAll: (q) => request('GET', `/conversations/search/all?q=${encodeURIComponent(q)}`),
  convSettings: (convId, b) => request('PATCH', `/conversations/${convId}/settings`, b),
  // 群组扩展
  updateAnnouncement: (gid, text) => request('PUT', `/groups/${gid}/announcement`, { text }),
  updateMyGroupNickname: (gid, name) => request('PUT', `/groups/${gid}/my-nickname`, { name }),
  setGroupAdmin: (gid, uid, admin) => request('PUT', `/groups/${gid}/admin/${uid}`, { admin }),
  // 在线状态
  myStatus: () => request('GET', '/users/me/status'),
  setMyStatus: (status) => request('PUT', '/users/me/status', { status }),
  // 自定义表情包 + 收藏
  myStickers: () => request('GET', '/stickers'),
  addSticker: (url) => request('POST', '/stickers', { url }),
  delSticker: (id) => request('DELETE', `/stickers/${id}`),
  savedList: () => request('GET', '/stickers/saved'),
  saveMessage: (msg) => request('POST', '/stickers/saved', { msg }),
  unsaveMessage: (id) => request('DELETE', `/stickers/saved/${id}`),
  // 上传
  upload: (base64, filename) => request('POST', '/upload', { data: base64, filename }),
};
