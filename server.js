const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

const ROLE_INFO = {
  gm: { name: 'GM（進行役）', icon: '👑', team: 'gm' },
  villager: { name: '市民', icon: '👤', team: 'village' },
  seer: { name: '占い師', icon: '🔮', team: 'village' },
  medium: { name: '霊媒師', icon: '👻', team: 'village' },
  knight: { name: '騎士', icon: '🛡️', team: 'village' },
  baker: { name: 'パン屋', icon: '🍞', team: 'village' },
  madman: { name: '狂人', icon: '🃏', team: 'wolf' },
  wolf: { name: '人狼', icon: '🐺', team: 'wolf' }
};

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getPlayers(room) {
  return room.participants.filter(p => !p.isGM);
}

function getAlivePlayers(room) {
  return room.participants.filter(p => !p.isGM && p.alive);
}

// 生存人数に応じたプリセット構成
function getDefaultRoleConfig(count, includeBaker) {
  const presets = {
    4:  { wolf: 1, madman: 0, seer: 1, medium: 0, knight: 1, baker: 0 },
    5:  { wolf: 1, madman: 0, seer: 1, medium: 1, knight: 1, baker: 0 },
    6:  { wolf: 1, madman: 1, seer: 1, medium: 1, knight: 1, baker: 0 },
    7:  { wolf: 2, madman: 0, seer: 1, medium: 1, knight: 1, baker: 0 },
    8:  { wolf: 2, madman: 1, seer: 1, medium: 1, knight: 1, baker: 0 },
    9:  { wolf: 2, madman: 1, seer: 1, medium: 1, knight: 1, baker: 0 },
    10: { wolf: 2, madman: 1, seer: 1, medium: 1, knight: 1, baker: includeBaker ? 1 : 0 },
    11: { wolf: 2, madman: 1, seer: 1, medium: 1, knight: 1, baker: includeBaker ? 1 : 0 },
    12: { wolf: 3, madman: 1, seer: 1, medium: 1, knight: 1, baker: includeBaker ? 1 : 0 }
  };
  const base = presets[count] || { wolf: 2, madman: 1, seer: 1, medium: 1, knight: 1, baker: includeBaker ? 1 : 0 };
  if (!includeBaker) base.baker = 0;
  const specialSum = base.wolf + base.madman + base.seer + base.medium + base.knight + base.baker;
  base.villager = Math.max(0, count - specialSum);
  return base;
}

// 昼や夜で未完了のアクションがあるかチェック
function getPendingActions(room) {
  const pending = [];
  const alive = getAlivePlayers(room);
  if (room.phase === 'vote') {
    alive.forEach(p => {
      if (!room.currentVotes[p.id]) pending.push(`${p.name}（未投票）`);
    });
  } else if (room.phase === 'night') {
    alive.forEach(p => {
      if (p.role === 'seer' && !room.nightActions.seerDone) pending.push(`${p.name}（占い未選択）`);
      if (p.role === 'knight' && !room.nightActions.knightDone) pending.push(`${p.name}（護衛未選択）`);
    });
    const aliveWolves = alive.filter(p => p.role === 'wolf');
    if (aliveWolves.length > 0 && !room.nightActions.wolfDone) {
      pending.push(`人狼陣営（襲撃未選択）`);
    }
  }
  return pending;
}

// 勝敗判定
function checkWinCondition(room) {
  const alive = getAlivePlayers(room);
  const wolves = alive.filter(p => p.role === 'wolf').length;
  const humans = alive.length - wolves;
  if (wolves === 0) return 'village';
  if (wolves >= humans) return 'wolf';
  return null;
}

// 各クライアントへパーソナライズした状態を送信
function broadcastRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const pendingActions = getPendingActions(room);
  const bakerAlive = getAlivePlayers(room).some(p => p.role === 'baker');
  const hadBaker = getPlayers(room).some(p => p.role === 'baker');

  room.participants.forEach(viewer => {
    if (!viewer.socketId) return;

    const isGameOver = room.phase === 'gameover';
    const isWolf = viewer.role === 'wolf';

    const publicPlayers = room.participants.filter(p => !p.isGM).map(p => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      deathDay: p.deathDay,
      deathReason: p.deathReason,
      coRole: p.coRole,
      publicNote: p.publicNote,
      isConfirmedWhite: p.isConfirmedWhite,
      voteLocked: p.voteLocked,
      // ゲーム終了後、またはGM、または仲間人狼には役職を開示
      revealedRole: (isGameOver || viewer.isGM || (isWolf && p.role === 'wolf')) ? p.role : null
    }));

    const payload = {
      roomCode: room.code,
      phase: room.phase,
      daySubPhase: room.daySubPhase,
      day: room.day,
      timer: room.timer,
      timerPaused: room.timerPaused,
      waitingForActions: room.waitingForActions,
      pendingActions: viewer.isGM ? pendingActions : [],
      pendingCount: pendingActions.length,
      roleConfig: room.roleConfig,
      includeBaker: room.includeBaker,
      firstSpeaker: room.firstSpeaker,
      morningMessage: room.morningMessage,
      bakerStatus: hadBaker ? (bakerAlive ? 'alive' : 'dead') : 'none',
      executedPlayerName: room.executedPlayerName,
      winner: room.winner,
      voteHistory: room.voteHistory,
      wolfChat: (isWolf || viewer.isGM) ? room.wolfChat : [],
      me: {
        id: viewer.id,
        name: viewer.name,
        isGM: viewer.isGM,
        alive: viewer.alive,
        role: viewer.role,
        roleInfo: ROLE_INFO[viewer.role] || ROLE_INFO.villager,
        seerHistory: viewer.seerHistory,
        mediumHistory: viewer.mediumHistory,
        lastGuardedId: viewer.lastGuardedId,
        currentVote: room.currentVotes[viewer.id] || null,
        nightSelection: getViewerNightSelection(room, viewer)
      },
      players: publicPlayers
    };

    io.to(viewer.socketId).emit('roomState', payload);
  });
}

function getViewerNightSelection(room, viewer) {
  if (room.phase !== 'night') return null;
  if (viewer.role === 'seer') return room.nightActions.seerTarget;
  if (viewer.role === 'knight') return room.nightActions.knightTarget;
  if (viewer.role === 'wolf') return room.nightActions.wolfTarget;
  return null;
}

// フェーズ遷移ロジック
function transitionToPhase(room, nextPhase) {
  room.waitingForActions = false;
  room.timerPaused = false;

  if (nextPhase === 'night0') {
    room.phase = 'night0';
    room.day = 0;
    room.timer = 45;
  } else if (nextPhase === 'day') {
    room.phase = 'day';
    room.daySubPhase = room.day === 1 ? 'order' : 'report';
    const aliveCount = getAlivePlayers(room).length;
    room.timer = Math.max(180, (aliveCount - 2) * 60); // 生存人数-2分（最低3分）
  } else if (nextPhase === 'vote') {
    room.phase = 'vote';
    room.currentVotes = {};
    room.timer = 60;
  } else if (nextPhase === ' tally_vote') {
    tallyVotesAndExecute(room);
    return;
  } else if (nextPhase === 'night') {
    // 処刑後の勝敗チェック
    const winAfterExec = checkWinCondition(room);
    if (winAfterExec) {
      room.phase = 'gameover';
      room.winner = winAfterExec;
      room.timer = 0;
      broadcastRoom(room.code);
      return;
    }
    room.phase = 'night';
    room.timer = 60;
    room.nightActions = {
      seerTarget: null,
      seerDone: false,
      knightTarget: null,
      knightDone: false,
      wolfTarget: null,
      wolfDone: false
    };
  } else if (nextPhase === 'resolve_night') {
    resolveNightAndStartMorning(room);
    return;
  }

  broadcastRoom(room.code);
}

// 開票と処刑処理
function tallyVotesAndExecute(room) {
  const alive = getAlivePlayers(room);
  const counts = {};
  const votersByTarget = {};

  alive.forEach(voter => {
    const targetId = room.currentVotes[voter.id];
    if (targetId) {
      counts[targetId] = (counts[targetId] || 0) + 1;
      if (!votersByTarget[targetId]) votersByTarget[targetId] = [];
      votersByTarget[targetId].push(voter.name);
    } else {
      if (!votersByTarget['未投票']) votersByTarget['未投票'] = [];
      votersByTarget['未投票'].push(voter.name);
    }
  });

  // 得票数順に整形
  const breakdown = Object.keys(votersByTarget).map(targetId => {
    const targetPlayer = room.participants.find(p => p.id === targetId);
    return {
      targetName: targetPlayer ? targetPlayer.name : '未投票',
      voters: votersByTarget[targetId],
      count: targetPlayer ? counts[targetId] : 0
    };
  }).sort((a, b) => b.count - a.count);

  room.voteHistory.unshift({
    day: room.day,
    breakdown
  });

  // 最多得票者の特定
  let maxVotes = 0;
  let topTargets = [];
  Object.entries(counts).forEach(([targetId, c]) => {
    if (c > maxVotes) {
      maxVotes = c;
      topTargets = [targetId];
    } else if (c === maxVotes) {
      topTargets.push(targetId);
    }
  });

  // 1名に決まった場合は処刑（同票の場合はランダムまたは最初の人ではなく、初心者村が詰まらないよう同票の中からランダム処刑、またはGM判断）
  // ここでは動画と同じく最多得票者を処刑対象とする
  const executedId = topTargets[0];
  const executedPlayer = room.participants.find(p => p.id === executedId);

  if (executedPlayer) {
    executedPlayer.alive = false;
    executedPlayer.deathDay = room.day;
    executedPlayer.deathReason = '処刑';
    room.executedPlayerName = executedPlayer.name;

    // 霊媒師全員に処刑結果を即時付与
    getPlayers(room).filter(p => p.role === 'medium').forEach(med => {
      med.mediumHistory.push({
        day: room.day,
        targetName: executedPlayer.name,
        isWolf: executedPlayer.role === 'wolf'
      });
    });
  } else {
    room.executedPlayerName = 'なし（同票）';
  }

  room.phase = 'lastwords';
  room.timer = 30;
  broadcastRoom(room.code);
}

// 夜のアクション解決と朝への移行
function resolveNightAndStartMorning(room) {
  const wolfTargetId = room.nightActions.wolfTarget;
  const knightTargetId = room.nightActions.knightTarget;

  // 騎士の護衛履歴を更新（連続護衛禁止用）
  getAlivePlayers(room).filter(p => p.role === 'knight').forEach(k => {
    if (knightTargetId) k.lastGuardedId = knightTargetId;
  });

  let victim = null;
  if (wolfTargetId && wolfTargetId !== 'PASS') {
    if (wolfTargetId !== knightTargetId) {
      const target = room.participants.find(p => p.id === wolfTargetId);
      if (target && target.alive) {
        target.alive = false;
        target.deathDay = room.day + 1;
        target.deathReason = '襲撃';
        victim = target;
      }
    }
  }

  room.day += 1;

  if (victim) {
    room.morningMessage = `昨夜の犠牲者は 【${victim.name}さん】 でした。`;
    // 次の順番発言の起点を犠牲者の次の生存者にする
    const players = getPlayers(room);
    const victimIdx = players.findIndex(p => p.id === victim.id);
    for (let i = 1; i <= players.length; i++) {
      const candidate = players[(victimIdx + i) % players.length];
      if (candidate.alive) {
        room.firstSpeaker = candidate.name;
        break;
      }
    }
  } else {
    room.morningMessage = `昨夜の犠牲者は 【いませんでした】（護衛成功 または 噛み無し）！`;
  }

  // 朝の勝敗判定
  const winAfterNight = checkWinCondition(room);
  if (winAfterNight) {
    room.phase = 'gameover';
    room.winner = winAfterNight;
    room.timer = 0;
    broadcastRoom(room.code);
    return;
  }

  transitionToPhase(room, 'day');
}

// 毎秒のタイマー処理
setInterval(() => {
  Object.values(rooms).forEach(room => {
    if (['lobby', 'gameover'].includes(room.phase)) return;
    if (room.timerPaused) return;

    if (room.timer > 0) {
      // 投票や夜フェーズで未選択者がいる場合、残り1秒でストップして警告を出す
      if (room.timer === 1 && (room.phase === 'vote' || room.phase === 'night')) {
        const pending = getPendingActions(room);
        if (pending.length > 0) {
          room.waitingForActions = true;
          broadcastRoom(room.code);
          return;
        }
      }
      room.timer -= 1;
      broadcastRoom(room.code);
    } else {
      // タイマーが0になった時の自動遷移
      if (room.phase === 'night0') {
        room.day = 1;
        room.morningMessage = '1日目の朝です（初日噛み無し）。順番発言を開始してください。';
        transitionToPhase(room, 'day');
      } else if (room.phase === 'day') {
        transitionToPhase(room, 'vote');
      } else if (room.phase === 'vote') {
        transitionToPhase(room, ' tally_vote');
      } else if (room.phase === 'lastwords') {
        transitionToPhase(room, 'night');
      } else if (room.phase === 'night') {
        transitionToPhase(room, 'resolve_night');
      }
    }
  });
}, 1000);

io.on('connection', socket => {
  // 部屋作成（GMとして入室）
  socket.on('createRoom', ({ name, includeBaker }) => {
    const code = generateRoomCode();
    const gmParticipant = {
      id: 'GM_' + Math.random().toString(36).substr(2, 6),
      socketId: socket.id,
      name: name || 'GM',
      isGM: true,
      alive: true,
      role: 'gm',
      seerHistory: [],
      mediumHistory: []
    };

    rooms[code] = {
      code,
      phase: 'lobby',
      daySubPhase: 'order',
      day: 0,
      timer: 0,
      timerPaused: false,
      waitingForActions: false,
      includeBaker: includeBaker !== false,
      roleConfig: getDefaultRoleConfig(10, includeBaker !== false),
      participants: [gmParticipant],
      firstSpeaker: '',
      morningMessage: '',
      executedPlayerName: '',
      currentVotes: {},
      voteHistory: [],
      wolfChat: [],
      nightActions: {},
      winner: null
    };

    socket.join(code);
    socket.emit('joinedRoom', { roomCode: code, participantId: gmParticipant.id });
    broadcastRoom(code);
  });

  // 部屋参加（プレイヤーまたはGM再接続）
  socket.on('joinRoom', ({ roomCode, name, participantId }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('errorMessage', '指定されたゲームコードの部屋が見つかりません。');
      return;
    }

    // 既存参加者の再接続チェック
    let existing = room.participants.find(p => p.id === participantId || p.name === name);
    if (existing) {
      existing.socketId = socket.id;
      socket.join(roomCode);
      socket.emit('joinedRoom', { roomCode, participantId: existing.id });
      broadcastRoom(roomCode);
      return;
    }

    if (room.phase !== 'lobby') {
      socket.emit('errorMessage', 'すでにゲームが開始されています。同じ名前を入力すると再接続できます。');
      return;
    }

    const newPlayer = {
      id: 'P_' + Math.random().toString(36).substr(2, 6),
      socketId: socket.id,
      name: name.trim(),
      isGM: false,
      alive: true,
      deathDay: null,
      deathReason: null,
      role: 'villager',
      coRole: '',
      publicNote: '',
      isConfirmedWhite: false,
      voteLocked: false,
      seerHistory: [],
      mediumHistory: [],
      lastGuardedId: null
    };

    room.participants.push(newPlayer);
    const pCount = getPlayers(room).length;
    if (pCount >= 4) {
      room.roleConfig = getDefaultRoleConfig(pCount, room.includeBaker);
    }

    socket.join(roomCode);
    socket.emit('joinedRoom', { roomCode, participantId: newPlayer.id });
    broadcastRoom(roomCode);
  });

  // パン屋有無の切り替え（ロビー）
  socket.on('toggleBaker', ({ roomCode, includeBaker }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'lobby') return;
    room.includeBaker = includeBaker;
    const pCount = Math.max(4, getPlayers(room).length || 10);
    room.roleConfig = getDefaultRoleConfig(pCount, includeBaker);
    broadcastRoom(roomCode);
  });

  // ゲーム開始処理
  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const players = getPlayers(room);
    if (players.length < 4) {
      socket.emit('errorMessage', 'ゲーム開始にはGM以外に最低4人のプレイヤーが必要です。');
      return;
    }

    const cfg = getDefaultRoleConfig(players.length, room.includeBaker);
    room.roleConfig = cfg;

    // 役職デッキの作成とシャッフル
    const deck = [];
    Object.entries(cfg).forEach(([roleKey, count]) => {
      for (let i = 0; i < count; i++) deck.push(roleKey);
    });
    while (deck.length < players.length) deck.push('villager');
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    players.forEach((p, idx) => {
      p.role = deck[idx];
      p.alive = true;
      p.deathDay = null;
      p.deathReason = null;
      p.coRole = '';
      p.publicNote = '';
      p.isConfirmedWhite = false;
      p.voteLocked = false;
      p.seerHistory = [];
      p.mediumHistory = [];
      p.lastGuardedId = null;
    });

    // 初日ランダム白の抽選（人狼以外から1名）
    const seers = players.filter(p => p.role === 'seer');
    seers.forEach(seer => {
      const whiteCandidates = players.filter(p => p.id !== seer.id && p.role !== 'wolf');
      if (whiteCandidates.length > 0) {
        const chosen = whiteCandidates[Math.floor(Math.random() * whiteCandidates.length)];
        seer.seerHistory.push({
          day: 0,
          label: '初日ランダム白',
          targetName: chosen.name,
          isWolf: false
        });
      }
    });

    // 初日の最初の順番発言者をランダム決定
    const randomStarter = players[Math.floor(Math.random() * players.length)];
    room.firstSpeaker = randomStarter.name;
    room.voteHistory = [];
    room.wolfChat = [];
    room.winner = null;

    transitionToPhase(room, 'night0');
  });

  // 0日目・夜の人狼チャット
  socket.on('sendWolfChat', ({ roomCode, senderName, text }) => {
    const room = rooms[roomCode];
    if (!room || !text.trim()) return;
    room.wolfChat.push({ sender: senderName, text: text.trim() });
    broadcastRoom(roomCode);
  });

  // 投票アクション
  socket.on('submitVote', ({ roomCode, voterId, targetId }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'vote') return;
    const target = room.participants.find(p => p.id === targetId);
    if (!target || target.isGM || !target.alive || target.voteLocked || voterId === targetId) return;

    room.currentVotes[voterId] = targetId;

    // 全員が投票完了していて、タイマーが1秒で待機中なら即開票へ
    const pending = getPendingActions(room);
    if (pending.length === 0 && room.waitingForActions) {
      transitionToPhase(room, ' tally_vote');
    } else {
      broadcastRoom(roomCode);
    }
  });

  // 夜の役職アクション
  socket.on('submitNightAction', ({ roomCode, actorId, targetId }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'night') return;
    const actor = room.participants.find(p => p.id === actorId);
    if (!actor || !actor.alive) return;

    if (actor.role === 'seer' && !room.nightActions.seerDone) {
      const target = room.participants.find(p => p.id === targetId);
      if (!target || target.isGM || !target.alive || target.id === actor.id) return;
      room.nightActions.seerTarget = targetId;
      room.nightActions.seerDone = true;
      actor.seerHistory.push({
        day: room.day,
        label: `${room.day}日目夜`,
        targetName: target.name,
        isWolf: target.role === 'wolf'
      });
    } else if (actor.role === 'knight' && !room.nightActions.knightDone) {
      const target = room.participants.find(p => p.id === targetId);
      if (!target || target.isGM || !target.alive || target.id === actor.id) return;
      if (actor.lastGuardedId === targetId) return; // 連続護衛禁止
      room.nightActions.knightTarget = targetId;
      room.nightActions.knightDone = true;
    } else if (actor.role === 'wolf') {
      // 噛み無し（PASS）または人狼以外の生存者を指定可能（自噛み・仲間噛み禁止）
      if (targetId === 'PASS') {
        room.nightActions.wolfTarget = 'PASS';
        room.nightActions.wolfDone = true;
      } else {
        const target = room.participants.find(p => p.id === targetId);
        if (!target || target.isGM || !target.alive || target.role === 'wolf') return;
        room.nightActions.wolfTarget = targetId;
        room.nightActions.wolfDone = true;
      }
    }

    const pending = getPendingActions(room);
    if (pending.length === 0 && room.waitingForActions) {
      transitionToPhase(room, 'resolve_night');
    } else {
      broadcastRoom(roomCode);
    }
  });

  // GM操作：盤面共有ボードの更新（CO・結果メモ・確白・投票ロック）
  socket.on('gmUpdateBoard', ({ roomCode, playerId, coRole, publicNote, isConfirmedWhite, voteLocked }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const target = room.participants.find(p => p.id === playerId);
    if (!target) return;

    if (coRole !== undefined) target.coRole = coRole;
    if (publicNote !== undefined) target.publicNote = publicNote;
    if (isConfirmedWhite !== undefined) target.isConfirmedWhite = isConfirmedWhite;
    if (voteLocked !== undefined) target.voteLocked = voteLocked;

    broadcastRoom(roomCode);
  });

  // GM操作：昼のサブフェーズ切り替え（結果報告 / 順番発言 / 自由議論 / 指名発言・COロック）
  socket.on('gmSetDaySubPhase', ({ roomCode, subPhase }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'day') return;
    room.daySubPhase = subPhase;
    if (subPhase === 'lock') {
      room.timer = 60; // 指名発言に切り替えたら自動で1分にセット
    }
    broadcastRoom(roomCode);
  });

  // GM操作：タイマー＆フェーズ制御
  socket.on('gmControl', ({ roomCode, action }) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (action === 'togglePause') {
      room.timerPaused = !room.timerPaused;
    } else if (action === 'addMinute') {
      room.timer += 60;
    } else if (action === 'minus30') {
      room.timer = Math.max(5, room.timer - 30);
    } else if (action === 'skipPhase') {
      if (room.phase === 'night0') {
        room.day = 1;
        room.morningMessage = '1日目の朝です（初日噛み無し）。順番発言を開始してください。';
        transitionToPhase(room, 'day');
      } else if (room.phase === 'day') {
        transitionToPhase(room, 'vote');
      } else if (room.phase === 'vote') {
        transitionToPhase(room, ' tally_vote');
      } else if (room.phase === 'lastwords') {
        transitionToPhase(room, 'night');
      } else if (room.phase === 'night') {
        transitionToPhase(room, 'resolve_night');
      }
      return;
    } else if (action === 'resetToLobby') {
      room.phase = 'lobby';
      room.day = 0;
      room.timer = 0;
      broadcastRoom(roomCode);
      return;
    }

    broadcastRoom(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Werewolf GM Server running on http://localhost:${PORT}`);
});