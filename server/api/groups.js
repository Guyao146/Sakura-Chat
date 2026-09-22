'use strict';

const express = require('express');
const { db, groupConvId, safeUser, getUserById } = require('../db');
const { groupMemberIds } = require('../services');
const state = require('../state');
const { insertSystemMessage } = require('../messaging');

const router = express.Router();

/** 我的群列表 */
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT g.id, g.name, g.avatar, g.owner_id, g.announcement, g.created_at, m.role
    FROM group_members m JOIN groups g ON g.id = m.group_id
    WHERE m.user_id = ?
    ORDER BY g.created_at DESC
  `).all(req.user.id);
  res.json({ groups: rows });
});

/** 群资料（含成员） */
router.get('/:id', (req, res) => {
  const gid = Number(req.params.id);
  if (!gid) return res.status(400).json({ error: '无效的群' });
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(gid);
  if (!g) return res.status(404).json({ error: '群不存在' });
  const members = db.prepare(`
    SELECT m.role, m.joined_at, m.display_name, u.id, u.username, u.nickname, u.avatar
    FROM group_members m JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ? ORDER BY m.role DESC, m.joined_at ASC
  `).all(gid);
  res.json({
    group: {
      id: g.id, name: g.name, avatar: g.avatar, ownerId: g.owner_id,
      announcement: g.announcement, createdAt: g.created_at,
      members: members.map(m => ({ ...safeUser(m), role: m.role, joinedAt: m.joined_at, displayName: m.display_name || '' })),
    },
  });
});

/** 建群 */
router.post('/', (req, res) => {
  const name = (typeof req.body.name === 'string' ? req.body.name.trim() : '') || '新的群聊';
  if (name.length > 30) return res.status(400).json({ error: '群名最多 30 个字符' });
  const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds.map(Number).filter(Boolean) : [];
  if (!memberIds.length) return res.status(400).json({ error: '请至少选择一位群成员' });
  const self = req.user.id;
  const uniq = [...new Set([self, ...memberIds])].filter(id => getUserById(id) || id === self);
  if (uniq.length < 3) return res.status(400).json({ error: '群聊至少需要 3 名成员（含自己）' });

  const now = Date.now();
  const info = db.prepare('INSERT INTO groups (name, owner_id, created_at) VALUES (?, ?, ?)')
    .run(name, self, now);
  const gid = Number(info.lastInsertRowid);
  const insertMember = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
  for (const uid of uniq) insertMember.run(gid, uid, uid === self ? 2 : 0, now);

  const convId = groupConvId(gid);
  const me = getUserById(self);
  const names = uniq.filter(id => id !== self).map(id => getUserById(id)?.nickname).filter(Boolean).join('、');
  const text = `${me.nickname} 创建了群聊，并邀请了 ${names} 加入`;
  const sys = insertSystemMessage('group', convId, text);
  const sysMsg = {
    id: sys.id, msgId: 'sys', convType: 'group', convId, groupId: gid, senderId: 0,
    kind: 'system', content: { text }, createdAt: sys.createdAt, revoked: 0,
  };
  // 通知被邀请人：实时拉取新会话 + 展示系统消息
  for (const uid of uniq) {
    if (uid === self) continue;
    state.sendToUser(uid, { type: 'message', msg: sysMsg });
    state.sendToUser(uid, { type: 'group_invited', groupId: gid, groupName: name, inviter: safeUser(me) });
  }

  res.json({ group: { id: gid, name, ownerId: self, createdAt: now } });
});

/** 邀请成员 */
router.post('/:id/members', (req, res) => {
  const gid = Number(req.params.id);
  const userIds = Array.isArray(req.body.userIds) ? req.body.userIds.map(Number).filter(Boolean) : [];
  if (!gid || !userIds.length) return res.status(400).json({ error: '参数无效' });
  if (!isGroupMemberOf(gid, req.user.id)) return res.status(403).json({ error: '你不是群成员' });
  const now = Date.now();
  const insertMember = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 0, ?)');
  const added = [];
  for (const uid of userIds) {
    if (!getUserById(uid) || isGroupMemberOf(gid, uid)) continue;
    insertMember.run(gid, uid, now);
    added.push(uid);
  }
  if (!added.length) return res.json({ message: '没有新成员被邀请', addedCount: 0 });

  const convId = groupConvId(gid);
  const me = getUserById(req.user.id);
  const names = added.map(id => getUserById(id)?.nickname).filter(Boolean).join('、');
  const text = `${me.nickname} 邀请 ${names} 加入了群聊`;
  const sys = insertSystemMessage('group', convId, text);
  const sysMsg = {
    id: sys.id, msgId: 'sys', convType: 'group', convId, groupId: gid, senderId: 0,
    kind: 'system', content: { text }, createdAt: sys.createdAt, revoked: 0,
  };
  for (const uid of groupMemberIds(gid)) {
    state.sendToUser(uid, { type: 'message', msg: sysMsg });
    if (added.includes(uid)) {
      state.sendToUser(uid, { type: 'group_invited', groupId: gid, groupName: groupName(gid), inviter: safeUser(me) });
    }
  }
  res.json({ message: '邀请成功', addedCount: added.length });
});

/** 退群 / 踢人 */
router.delete('/:id/members/:userId', (req, res) => {
  const gid = Number(req.params.id);
  const target = Number(req.params.userId);
  const self = req.user.id;
  if (!gid || !target) return res.status(400).json({ error: '参数无效' });
  if (!isGroupMemberOf(gid, self)) return res.status(403).json({ error: '你不是群成员' });

  const g = db.prepare('SELECT name, owner_id FROM groups WHERE id = ?').get(gid);
  if (!g) return res.status(404).json({ error: '群不存在' });

  if (target !== self) {
    // 群主可踢任何人；管理员只能踢普通成员
    const myRole = self === g.owner_id ? 2 : (isGroupAdminOf(gid, self) ? 1 : 0);
    if (myRole === 0) return res.status(403).json({ error: '只有群主或管理员才能移除成员' });
    if (g.owner_id === target) return res.status(403).json({ error: '不能移除群主' });
    if (myRole === 1 && isGroupAdminOf(gid, target)) {
      return res.status(403).json({ error: '管理员不能移除其他管理员' });
    }
  }
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, target);

  const convId = groupConvId(gid);
  const who = getUserById(target);
  const me = getUserById(self);
  const text = target === self ? `${me.nickname} 退出了群聊` : `${me.nickname} 将 ${who?.nickname || '成员'} 移出了群聊`;
  const sys = insertSystemMessage('group', convId, text);
  const sysMsg = {
    id: sys.id, msgId: 'sys', convType: 'group', convId, groupId: gid, senderId: 0,
    kind: 'system', content: { text }, createdAt: sys.createdAt, revoked: 0,
  };
  for (const uid of [...groupMemberIds(gid), target]) {
    state.sendToUser(uid, {
      type: target === self ? 'group_left' : 'group_event',
      groupId: gid, groupName: g.name, message: sysMsg,
    });
  }

  // 群主退出 -> 解散群聊
  if (target === self && g.owner_id === self) {
    dismiss(gid, g.name);
  }
  res.json({ message: target === self ? '已退出群聊' : '已移除成员' });
});

/** 修改群公告（群主或管理员） */
router.put('/:id/announcement', (req, res) => {
  const gid = Number(req.params.id);
  const text = typeof req.body.text === 'string' ? req.body.text.trim().slice(0, 200) : '';
  if (!gid) return res.status(400).json({ error: '无效的群' });
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(gid);
  if (!g) return res.status(404).json({ error: '群不存在' });
  if (!isGroupAdmin(gid, req.user.id)) return res.status(403).json({ error: '只有群主或管理员才能修改公告' });

  db.prepare('UPDATE groups SET announcement = ? WHERE id = ?').run(text, gid);
  const convId = groupConvId(gid);
  const me = getUserById(req.user.id);
  const sysText = text
    ? `${me.nickname} 修改了群公告：${text}`
    : `${me.nickname} 清空了群公告`;
  const sys = insertSystemMessage('group', convId, sysText);
  const sysMsg = {
    id: sys.id, msgId: 'sys', convType: 'group', convId, groupId: gid, senderId: 0,
    kind: 'system', content: { text: sysText }, createdAt: sys.createdAt, revoked: 0,
  };
  for (const uid of groupMemberIds(gid)) {
    state.sendToUser(uid, { type: 'message', msg: sysMsg });
    state.sendToUser(uid, { type: 'group_announcement', groupId: gid, announcement: text });
  }
  res.json({ message: '公告已更新', announcement: text });
});

/** 修改自己在群内的昵称（群昵称，QQ/微信式） */
router.put('/:id/my-nickname', (req, res) => {
  const gid = Number(req.params.id);
  const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 20) : '';
  if (!gid) return res.status(400).json({ error: '无效的群' });
  if (!isGroupMemberOf(gid, req.user.id)) return res.status(403).json({ error: '你不是群成员' });
  db.prepare('UPDATE group_members SET display_name = ? WHERE group_id = ? AND user_id = ?')
    .run(name, gid, req.user.id);
  res.json({ message: 'ok', displayName: name });
});

/** 设置/取消管理员（仅群主） */
router.put('/:id/admin/:userId', (req, res) => {
  const gid = Number(req.params.id);
  const target = Number(req.params.userId);
  const makeAdmin = req.body.admin === true;
  if (!gid || !target) return res.status(400).json({ error: '参数无效' });
  const g = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(gid);
  if (!g) return res.status(404).json({ error: '群不存在' });
  if (g.owner_id !== req.user.id) return res.status(403).json({ error: '只有群主才能设置管理员' });
  if (target === req.user.id) return res.status(400).json({ error: '不能对自己操作' });
  if (!isGroupMemberOf(gid, target)) return res.status(400).json({ error: '对方不是群成员' });
  db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?')
    .run(makeAdmin ? 1 : 0, gid, target);
  const me = getUserById(req.user.id);
  const who = getUserById(target);
  const convId = groupConvId(gid);
  const sysText = makeAdmin
    ? `${me.nickname} 将 ${who?.nickname || '成员'} 设置为了管理员`
    : `${me.nickname} 撤销了 ${who?.nickname || '成员'} 的管理员权限`;
  const sys = insertSystemMessage('group', convId, sysText);
  const sysMsg = {
    id: sys.id, msgId: 'sys', convType: 'group', convId, groupId: gid, senderId: 0,
    kind: 'system', content: { text: sysText }, createdAt: sys.createdAt, revoked: 0,
  };
  for (const uid of groupMemberIds(gid)) state.sendToUser(uid, { type: 'message', msg: sysMsg });
  res.json({ message: makeAdmin ? '已设为管理员' : '已撤销管理员' });
});

/** 解散群聊（仅群主） */
router.post('/:id/dismiss', (req, res) => {
  const gid = Number(req.params.id);
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(gid);
  if (!g) return res.status(404).json({ error: '群不存在' });
  if (g.owner_id !== req.user.id) return res.status(403).json({ error: '只有群主才能解散群聊' });
  dismiss(gid, g.name);
  res.json({ message: '群已解散' });
});

function dismiss(gid, name) {
  const members = groupMemberIds(gid);
  db.prepare('DELETE FROM group_members WHERE group_id = ?').run(gid);
  db.prepare('DELETE FROM groups WHERE id = ?').run(gid);
  for (const uid of members) {
    state.sendToUser(uid, { type: 'group_dismissed', groupId: gid, groupName: name });
  }
}

function isGroupMemberOf(gid, uid) {
  return !!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(gid, uid);
}
function isGroupAdminOf(gid, uid) {
  const row = db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(gid, uid);
  return !!row && row.role >= 1;
}
function groupName(gid) {
  const g = db.prepare('SELECT name FROM groups WHERE id = ?').get(gid);
  return g ? g.name : '群聊';
}

/** 判断用户在群内的管理权限（群主或管理员） */
function isGroupAdmin(gid, uid) {
  const g = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(gid);
  if (g && g.owner_id === uid) return true;
  return isGroupAdminOf(gid, uid);
}

module.exports = router;
module.exports.isGroupAdmin = isGroupAdmin;
module.exports.isGroupMemberOf = isGroupMemberOf;

