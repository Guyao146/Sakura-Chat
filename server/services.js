'use strict';

/**
 * 领域服务：会话权限校验、好友/群成员关系、会话内广播
 */

const { db, singleConvId, groupConvId } = require('./db');
const state = require('./state');

function friendList(userId) {
  return db.prepare(`
    SELECT f.friend_id AS uid, f.remark FROM friendships f WHERE f.user_id = ? AND f.status = 1
    UNION
    SELECT f.user_id AS uid, '' AS remark FROM friendships f WHERE f.friend_id = ? AND f.status = 1
  `).all(userId, userId);
}

function friendIds(userId) {
  return friendList(userId).map(r => r.uid);
}

function areFriends(a, b) {
  const row = db.prepare(`
    SELECT 1 FROM friendships
    WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)) AND status = 1
  `).get(a, b, b, a);
  return !!row;
}

function groupIdsOf(userId) {
  return db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId).map(r => r.group_id);
}

function groupMemberIds(groupId) {
  return db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId).map(r => r.user_id);
}

function isGroupMember(groupId, userId) {
  return !!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
}

/**
 * 解析会话 id，返回该会话的"参与者 id 列表"（不含参数中的当前用户亦可）
 * single: u_1_2 -> [1, 2]   group: g_3 -> 全体成员
 */
function convParticipants(convId) {
  if (!convId) return [];
  if (convId.startsWith('u_')) {
    const parts = convId.split('_');
    if (parts.length !== 3) return [];
    return [Number(parts[1]), Number(parts[2])].filter(n => Number.isInteger(n) && n > 0);
  }
  if (convId.startsWith('g_')) {
    const gid = Number(convId.slice(2));
    if (!gid) return [];
    return groupMemberIds(gid);
  }
  return [];
}

/** 当前用户是否可访问该会话（是单聊双方且为好友 / 群成员） */
function canAccessConv(userId, convId) {
  if (!convId) return false;
  if (convId.startsWith('u_')) {
    const ps = convParticipants(convId);
    if (!ps.includes(Number(userId))) return false;
    const other = ps.find(x => x !== Number(userId));
    return areFriends(userId, other);
  }
  if (convId.startsWith('g_')) {
    return isGroupMember(Number(convId.slice(2)), userId);
  }
  return false;
}

/** 会话内广播（自动跳过 excludeUserId） */
function broadcastToConv(convId, obj, excludeUserId) {
  const ids = new Set(convParticipants(convId));
  for (const uid of ids) {
    if (excludeUserId && uid === excludeUserId) continue;
    state.sendToUser(uid, obj);
  }
}

/** 向用户的所有好友与群友广播在线状态（隐身时 visible=false） */
function broadcastPresence(userId, online, status) {
  const targets = new Set([...friendIds(userId)]);
  for (const gid of groupIdsOf(userId)) {
    for (const mid of groupMemberIds(gid)) targets.add(mid);
  }
  targets.delete(userId);
  const payload = { type: 'presence', userId, online: !!online, status: status || (online ? 'online' : 'offline'), ts: Date.now() };
  for (const uid of targets) state.sendToUser(uid, payload);
}

module.exports = {
  friendList, friendIds, areFriends,
  groupIdsOf, groupMemberIds, isGroupMember,
  convParticipants, canAccessConv,
  broadcastToConv, broadcastPresence,
};
