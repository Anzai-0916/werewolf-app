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
  wolf: { name: '人狼', icon: '🐺', team: 'wolf' },
  madman: { name: '狂人', icon: '🃏', team: 'wolf' },
  seer: { name: '占い師', icon: '🔮', team: 'village' },
  medium: { name: '霊媒師', icon: '👻', team: 'village' },
  knight: { name: '騎士', icon: '🛡️', team: 'village' },
  villager: { name: '市民', icon: '👤', team: 'village' },
  baker: { name: 'パン屋', icon: '🍞', team: 'village' }
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

// タイマーの秒数だけを軽量送信（画面の入力欄やプルダウンが閉じないようにするため）
function broadcastTimer(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit('timerTick', {
    timer: room.timer,
    timerPaused: room.timerPaused,
    waitingForActions: room.waitingForActions
  });
}

// 各クライアントへ状態を送信
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
      timeConfig: room.timeConfig,
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
    room.timer = room.timeConfig.night0;
  } else if (nextPhase === 'day') {
    room.phase = 'day';
    room.daySubPhase = room.day === 1 ? 'order' : 'report';
    room.timer = room.timeConfig.day;
  } else if (nextPhase === 'vote') {
    room.phase = 'vote';
    room.currentVotes = {};
    room.timer = room.timeConfig.vote;
  } else if (nextPhase === 'tally_vote') {
    tallyVotesAndExecute(room);
    return;
  } else if (nextPhase === 'night') {
    const winAfterExec = checkWinCondition(room);
    if (winAfterExec) {
      room.phase = 'gameover';
      room.winner = winAfterExec;
      room.timer = 0;
      broadcastRoom(room.code);
      return;
    }
    room.phase = 'night';
    room.timer = room.timeConfig.night;
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

  const executedId = topTargets[0];
  const executedPlayer = room.participants.find(p => p.id === executedId);

  if (executedPlayer) {
    executedPlayer.alive = false;
    executedPlayer.deathDay = room.day; // 1日目の昼なら「1日目処刑」と記録
    executedPlayer.deathReason = '処刑';
    room.executedPlayerName = executedPlayer.name;

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
  room.timer = room.timeConfig.lastwords;
  broadcastRoom(room.code);
}

// 夜のアクション解決と朝への移行
function resolveNightAndStartMorning(room) {
  const wolfTargetId = room.nightActions.wolfTarget;
  const knightTargetId = room.nightActions.knightTarget;

  getAlivePlayers(room).filter(p => p.role === 'knight').forEach(k => {
    if (knightTargetId) k.lastGuardedId = knightTargetId;
  });

  let victim = null;
  if (wolfTargetId && wolfTargetId !== 'PASS') {
    if (wolfTargetId !== knightTargetId) {
      const target = room.participants.find(p => p.id === wolfTargetId);
      if (target && target.alive) {
        target.alive = false;
        target.deathDay = room.day; // 1日目の夜なら「1日目襲撃」と記録
        target.deathReason = '襲撃';
        victim = target;
      }
    }
  }

  room.day += 1;

  if (victim) {
    room.morningMessage = `昨夜の犠牲者は 【${victim.name}さん】 でした。`;
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
    room.morningMessage = `昨夜の犠牲者はいませんでした。`;
  }

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

// 毎秒のタイマー処理（画面全体ではなく時計のみを更新）
setInterval(() => {
  Object.values(rooms).forEach(room => {
    if (['lobby', 'gameover'].includes(room.phase)) return;
    if (room.timerPaused) return;

    if (room.timer > 0) {
      if (room.timer === 1 && (room.phase === 'vote' || room.phase === 'night')) {
        const pending = getPendingActions(room);
        if (pending.length > 0) {
          if (!room.waitingForActions) {
            room.waitingForActions = true;
            broadcastRoom(room.code);
          }
          return;
        }
      }
      room.timer -= 1;
      broadcastTimer(room.code);
    } else {
      if (room.phase === 'night0') {
        room.day = 1;
        room.morningMessage = '1日目の朝です（初日噛み無し）。順番発言を開始してください。';
        transitionToPhase(room, 'day');
      } else if (room.phase === 'day') {
        transitionToPhase(room, 'vote');
      } else if (room.phase === 'vote') {
        transitionToPhase(room, 'tally_vote');
      } else if (room.phase === 'lastwords') {
        transitionToPhase(room, 'night');
      } else if (room.phase === 'night') {
        transitionToPhase(room, 'resolve_night');
      }
    }
  });
}, 1000);

io.on('connection', socket => {
  // 部屋作成（GM）
  socket.on('createRoom', ({ name }) => {
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
      roleConfig: {
        wolf: 2,
        madman: 1,
        seer: 1,
        medium: 1,
        knight: 1,
        villager: 3,
        baker: 1
      },
      timeConfig: {
        night0: 45,
        day: 480,
        vote: 60,
        lastwords: 30,
        night: 60
      },
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

  // 部屋参加
  socket.on('joinRoom', ({ roomCode, name, participantId }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('errorMessage', '指定されたゲームコードの部屋が見つかりません。');
      return;
    }

    let existing = null;
    if (participantId) {
      existing = room.participants.find(p => p.id === participantId);
    } else if (name) {
      existing = room.participants.find(p => p.name === name.trim());
    }

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
    socket.join(roomCode);
    socket.emit('joinedRoom', { roomCode, participantId: newPlayer.id });
    broadcastRoom(roomCode);
  });

  // GMロビー設定：役職配分の変更
  socket.on('updateRoleConfig', ({ roomCode, roleKey, delta }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'lobby') return;
    if (room.roleConfig[roleKey] !== undefined) {
      room.roleConfig[roleKey] = Math.max(0, room.roleConfig[roleKey] + delta);
      broadcastRoom(roomCode);
    }
  });

  // GMロビー設定：時間設定の変更
  socket.on('updateTimeConfig', ({ roomCode, timeKey, seconds }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'lobby') return;
    const val = parseInt(seconds, 10);
    if (!isNaN(val) && val >= 5) {
      room.timeConfig[timeKey] = val;
      broadcastRoom(roomCode);
    }
  });

  // ゲーム開始処理
  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const players = getPlayers(room);
    const totalRoles = Object.values(room.roleConfig).reduce((a, b) => a + b, 0);

    if (players.length < 2) {
      socket.emit('errorMessage', 'プレイヤーが足りません。');
      return;
    }
    if (totalRoles !== players.length) {
      socket.emit('errorMessage', `役職の合計人数（${totalRoles}人）と参加プレイヤー数（${players.length}人）を一致させてください。`);
      return;
    }

    const deck = [];
    Object.entries(room.roleConfig).forEach(([roleKey, count]) => {
      for (let i = 0; i < count; i++) deck.push(roleKey);
    });
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

    // 初日ランダム白の抽選
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

    const randomStarter = players[Math.floor(Math.random() * players.length)];
    room.firstSpeaker = randomStarter.name;
    room.voteHistory = [];
    room.wolfChat = [];
    room.winner = null;

    transitionToPhase(room, 'night0');
  });

  // 人狼＆GMの夜会話チャット（0日目・1日目以降の夜すべて対応）
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

    const pending = getPendingActions(room);
    if (pending.length === 0 && room.waitingForActions) {
      transitionToPhase(room, 'tally_vote');
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
      if (actor.lastGuardedId === targetId) return;
      room.nightActions.knightTarget = targetId;
      room.nightActions.knightDone = true;
    } else if (actor.role === 'wolf') {
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

  // GM操作：盤面共有ボードの更新
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

  // GM操作：昼のサブフェーズ切り替え（タイマーはリセットせずそのまま継続）
  socket.on('gmSetDaySubPhase', ({ roomCode, subPhase }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'day') return;
    room.daySubPhase = subPhase;
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
        transitionToPhase(room, 'tally_vote');
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
  console.log(`Werewolf Server running on http://localhost:${PORT}`);
});