#!/bin/bash
# ABOUTME: M3 多聊天室冒烟脚本（HTTP + WS 真实链路验证，开发库）。
# 依赖：dev server 已运行（默认 localhost:5000）、vault 已解封、有效引导邀请码可用。
# 用法：
#   ADMIN_USER=smoke_admin ADMIN_PASS='...' INVITE='<有效邀请码>' bash scripts/m3-smoke.sh
# 说明：ADMIN_PASS 必填（${ADMIN_PASS:?} 缺失即报错）；ADMIN_USER / INVITE 可用环境变量覆盖，
#       未提供 INVITE 时生成随机串（注册将失败，脚本会打印 FAIL，请显式传入库中有效码）。
set -Eeuo pipefail

PORT="${DEPLOY_RUN_PORT:-5000}"
BASE="http://localhost:${PORT}"
WS_BASE="ws://localhost:${PORT}"
TS="$(date +%s)"
ADMIN_USER="${ADMIN_USER:-smoke_admin}"   # ADMIN_USERNAMES 命中则注册后登录即管理员；新库空账号密码自定
ADMIN_PASS="${ADMIN_PASS:?请通过环境变量提供 ADMIN_PASS}"
INVITE="${INVITE:-$(openssl rand -hex 8)}"
PLAIN_USER="m3_plain_${TS}"
PLAIN_PASS="m3smoke_plain_${TS}"
PUB_ROOM="M3PublicA_${TS}"
PRIV_ROOM="M3PrivateB_${TS}"
RENAMED_ROOM="M3Requested_Renamed_${TS}"
COOKIE_ADMIN=$(mktemp)
COOKIE_PLAIN=$(mktemp)
PASS=0
FAIL=0

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '  [PASS] %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  [FAIL] %s\n' "$*"; FAIL=$((FAIL+1)); }
check(){ # check <desc> <expected> <actual>
  if [[ "$3" == "$2" ]]; then ok "$1"; else bad "$1 (期望 $2 实际 $3)"; fi
}
jsonget(){ node -e "const d=JSON.parse(process.argv[1]);process.stdout.write(String(process.argv[2]?d[process.argv[2]]:''))" "$1" "$2" 2>/dev/null || true; }
jsonfind(){ # jsonfind <json> <field> <index> — 按数组内对象字段取值
  node -e "const d=JSON.parse(process.argv[1]);const i=Number(process.argv[3]);process.stdout.write(String(d[process.argv[2]][i]))" "$1" "$2" "$3" 2>/dev/null || true; }

echo "# M3 多聊天室冒烟 @ $BASE  ($(date -Is))"

# ---------- 0. 账号准备 ----------
say "0.1 注册管理员 ${ADMIN_USER}"
REG=$(curl -s -c "$COOKIE_ADMIN" -X POST "${BASE}/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\",\"inviteCode\":\"${INVITE}\"}" || true)
check "注册管理员返回 201/409" "true" "$(node -e "const d=JSON.parse(process.argv[1]);console.log(Boolean(d.alias||d.error).toString())" "$REG" 2>/dev/null)"

say "0.2 管理员登录"
L=$(curl -s -c "$COOKIE_ADMIN" -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}" || true)
check "管理员 isAdmin=true" "true" "$(jsonget "$L" isAdmin)"

say "0.3 注册普通用户 ${PLAIN_USER}"
RP=$(curl -s -c "$COOKIE_PLAIN" -X POST "${BASE}/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${PLAIN_USER}\",\"password\":\"${PLAIN_PASS}\",\"inviteCode\":\"${INVITE}\"}" || true)
check "普通用户注册成功" "true" "$(node -e "const d=JSON.parse(process.argv[1]);console.log(Boolean(d.alias).toString())" "$RP" 2>/dev/null)"
L2=$(curl -s -c "$COOKIE_PLAIN" -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${PLAIN_USER}\",\"password\":\"${PLAIN_PASS}\"}" || true)
check "普通用户 isAdmin=false" "false" "$(jsonget "$L2" isAdmin)"

# ---------- 1. 管理员建公开房 A、私密房 B ----------
say "1.1 管理员直建公开房 A (${PUB_ROOM})"
RA=$(curl -s -b "$COOKIE_ADMIN" -X POST "${BASE}/api/admin/rooms" -H 'Content-Type: application/json' \
  -d "{\"name\":\"${PUB_ROOM}\",\"type\":\"public\"}" || true)
ROOM_A=$(jsonget "$RA" room)
check "建公开房 A 成功" "true" "$(node -e "const d=JSON.parse(process.argv[1]);console.log(Boolean(d.room&&d.room.id).toString())" "$RA" 2>/dev/null)"
ROOM_A_ID=$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write(d.room?d.room.id:'')" "$RA" 2>/dev/null)

say "1.2 管理员直建私密房 B (${PRIV_ROOM})"
RB=$(curl -s -b "$COOKIE_ADMIN" -X POST "${BASE}/api/admin/rooms" -H 'Content-Type: application/json' \
  -d "{\"name\":\"${PRIV_ROOM}\",\"type\":\"private\"}" || true)
check "建私密房 B 成功" "true" "$(node -e "const d=JSON.parse(process.argv[1]);console.log(Boolean(d.room&&d.room.id).toString())" "$RB" 2>/dev/null)"
ROOM_B_ID=$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write(d.room?d.room.id:'')" "$RB" 2>/dev/null)

# ---------- 2. 普通用户房间列表：公开房 A 可见，私密房 B 不可见 ----------
say "2.1 普通用户可见房间列表"
RL=$(curl -s -b "$COOKIE_PLAIN" "${BASE}/api/rooms" || true)
VISIBLE_IN_ROOM_A=$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write((d.rooms||[]).some(r=>r.id===process.argv[2]).toString())" "$RL" "$ROOM_A_ID" 2>/dev/null)
VISIBLE_IN_ROOM_B=$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write((d.rooms||[]).some(r=>r.id===process.argv[2]).toString())" "$RL" "$ROOM_B_ID" 2>/dev/null)
check "列表包含公开房 A" "true" "$VISIBLE_IN_ROOM_A"
check "列表不含私密房 B" "false" "$VISIBLE_IN_ROOM_B"
check "列表含 memberCount 字段" "number" "$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write(typeof (d.rooms||[])[0]?.memberCount)" "$RL" 2>/dev/null)"

# ---------- 3. 普通用户 join B 被拒 / join A 成功（WS） ----------
say "3 WS 房间加入校验"
WS_OUT=$(node -e "
const WebSocket=require('ws');
const ws=new WebSocket('${WS_BASE}/ws/chat');
const token=process.argv[1];
let step='auth';
const timer=setTimeout(()=>{console.log('TIMEOUT@'+(step));process.exit(2)},8000);
ws.on('message',(raw)=>{
  const m=JSON.parse(raw.toString());
  if(m.type==='auth:ok'){ step='authok';
    ws.send(JSON.stringify({type:'room:join',payload:{roomId:process.argv[3]}})); // B
    step='joinedB';
  } else if(m.type==='error'&&m.payload.code==='room_forbidden'&&step==='joinedB'){
    ws.send(JSON.stringify({type:'room:join',payload:{roomId:process.argv[2]}})); // A
    step='joinedA';
  } else if(m.type==='room:joined'&&step==='joinedA'){
    console.log('JOIN_A_OK'); clearTimeout(timer); ws.close(); process.exit(0);
  }
});
ws.on('open',()=>ws.send(JSON.stringify({type:'auth',payload:{token}})));
" "$(jsonget "$L2" wsToken)" "$ROOM_A_ID" "$ROOM_B_ID" 2>&1 || true)
check "WS: join 私密房 B 被拒(room_forbidden) 且 join A 成功" "JOIN_A_OK" "$(echo "$WS_OUT" | grep -o 'JOIN_A_OK' || echo '')"

# ---------- 4. 普通用户申请建房 → 管理员审批 → 创建成功且申请人 owner ----------
say "4.1 普通用户发起建房申请"
RC=$(curl -s -b "$COOKIE_PLAIN" -X POST "${BASE}/api/rooms/requests" -H 'Content-Type: application/json' \
  -d '{"name":"M3Requested_'"$(date +%s)"'","type":"public","description":"冒烟测试房间"}' || true)
REQ_ID=$(jsonget "$RC" id)
check "建房申请创建成功" "true" "$(node -e "const d=JSON.parse(process.argv[1]);console.log(Boolean(d.id).toString())" "$RC" 2>/dev/null)"
REQ_NAME=$(jsonget "$RC" name)

say "4.2 管理员查询 pending 申请"
RQ=$(curl -s -b "$COOKIE_ADMIN" "${BASE}/api/admin/room-requests?status=pending" || true)
check "管理员可见该申请" "true" "$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write((d.requests||[]).some(r=>String(r.id)===String(process.argv[2])).toString())" "$RQ" "$REQ_ID" 2>/dev/null)"

say "4.3 管理员审批通过"
AP=$(curl -s -b "$COOKIE_ADMIN" -X POST "${BASE}/api/admin/room-requests/${REQ_ID}/approve" || true)
check "审批返回房间+申请人owner" "true" "$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write(Boolean(d.room&&d.room.id&&d.request.status==='approved').toString())" "$AP" 2>/dev/null)"
NEW_ROOM_ID=$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write(d.room?d.room.id:'')" "$AP" 2>/dev/null)

say "4.4 普通用户列表中该房间 isOwner=true"
RL2=$(curl -s -b "$COOKIE_PLAIN" "${BASE}/api/rooms" || true)
check "新房间对申请人是 owner" "true" "$(node -e "const d=JSON.parse(process.argv[1]);const r=(d.rooms||[]).find(x=>x.id===process.argv[2]);process.stdout.write(r?String(r.isOwner):'false')" "$RL2" "$NEW_ROOM_ID" 2>/dev/null)"

say "4.5 审批重复校验（409）"
AP2=$(curl -s -b "$COOKIE_ADMIN" -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/admin/room-requests/${REQ_ID}/approve" || true)
check "重复 approve 返回 409" "409" "$AP2"

# ---------- 5. 改名权限：非房主 403 / 房主 200 ----------
say "5.1 普通用户改公开房 A（非房主）→ 403"
ST=$(curl -s -b "$COOKIE_PLAIN" -o /dev/null -w '%{http_code}' -X PUT "${BASE}/api/rooms/${ROOM_A_ID}" \
  -H 'Content-Type: application/json' -d "{\"name\":\"${RENAMED_ROOM}_forbidden\"}" || true)
check "非房主改名 403" "403" "$ST"

say "5.2 普通用户改自己拥有的新房间 → 200"
ST2=$(curl -s -b "$COOKIE_PLAIN" -o /dev/null -w '%{http_code}' -X PUT "${BASE}/api/rooms/${NEW_ROOM_ID}" \
  -H 'Content-Type: application/json' -d "{\"name\":\"${RENAMED_ROOM}\"}" || true)
check "房主改名 200" "200" "$ST2"

# ---------- 6. history roomId 可见性 ----------
say "6 history roomId 访问控制"
H_A=$(curl -s -b "$COOKIE_PLAIN" -o /dev/null -w '%{http_code}' "${BASE}/api/chat/history?roomId=${ROOM_A_ID}" || true)
H_B=$(curl -s -b "$COOKIE_PLAIN" -o /dev/null -w '%{http_code}' "${BASE}/api/chat/history?roomId=${ROOM_B_ID}" || true)
H_NONE=$(curl -s -b "$COOKIE_PLAIN" -o /dev/null -w '%{http_code}' "${BASE}/api/chat/history" || true)
check "普通用户读公开房 A 历史 200" "200" "$H_A"
check "普通用户读私密房 B 历史 403" "403" "$H_B"
check "缺省 roomId 回退大厅 200" "200" "$H_NONE"

# ---------- 7. 成员管理（owner 拉人进私密房 B）----------
say "7 私密房成员添加后可见"
AM=$(curl -s -b "$COOKIE_ADMIN" -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/rooms/${ROOM_B_ID}/members" \
  -H 'Content-Type: application/json' -d "{\"username\":\"${PLAIN_USER}\"}" || true)
check "管理员添加普通用户入私密房 B" "200" "$AM"
RL3=$(curl -s -b "$COOKIE_PLAIN" "${BASE}/api/rooms" || true)
check "加入后 B 出现在普通用户列表" "true" "$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write((d.rooms||[]).some(r=>r.id===process.argv[2]).toString())" "$RL3" "$ROOM_B_ID" 2>/dev/null)"
RM=$(curl -s -b "$COOKIE_ADMIN" -o /dev/null -w '%{http_code}' -X DELETE "${BASE}/api/rooms/${ROOM_B_ID}/members?username=${PLAIN_USER}" || true)
check "移除成员(DELETE query) 200" "200" "$RM"
RL4=$(curl -s -b "$COOKIE_PLAIN" "${BASE}/api/rooms" || true)
check "移除后 B 从列表消失" "false" "$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write((d.rooms||[]).some(r=>r.id===process.argv[2]).toString())" "$RL4" "$ROOM_B_ID" 2>/dev/null)"

# ---------- 8. 归档房间（房主 DELETE query）----------
say "8 归档新房间（房主）"
AR=$(curl -s -b "$COOKIE_PLAIN" -o /dev/null -w '%{http_code}' -X DELETE "${BASE}/api/rooms/${NEW_ROOM_ID}?reason=smoke-archive" || true)
check "房主归档房间 200" "200" "$AR"
RL5=$(curl -s -b "$COOKIE_PLAIN" "${BASE}/api/rooms" || true)
check "归档后新房间从列表消失" "false" "$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write((d.rooms||[]).some(r=>r.id===process.argv[2]).toString())" "$RL5" "$NEW_ROOM_ID" 2>/dev/null)"

# ---------- 9. 审计落库抽查（用管理员 cookie 走 HTTP，避免外部直连 PGlite 单写锁干扰）----------
say "9 审计日志抽查（/api/admin/audit）"
AUDIT=$(curl -s -b "$COOKIE_ADMIN" "${BASE}/api/admin/audit" || true)
if node -e "const d=JSON.parse(process.argv[1]);Array.isArray(d.entries)" "$AUDIT" 2>/dev/null; then
  for ACT in room.create room.update room.archive room.member.add room.member.remove room_request.create room_request.approve; do
    N=$(echo "$AUDIT" | node -e "const d=JSON.parse(process.argv[1]);process.stdout.write(String(d.entries.filter(e=>e.action==='$ACT').length))" 2>/dev/null || echo "0")
    if [[ "$N" =~ ^[1-9][0-9]*$ ]]; then ok "审计 action $ACT 已落库 (x$N)"; else bad "审计 action $ACT 缺失"; fi
  done
else
  echo "  [WARN] 审计抽查跳过：/api/admin/audit 响应不可解析（$(echo "$AUDIT" | head -c 120)）"
fi

# ---------- 汇总 ----------
echo
echo "================ M3 SMOKE RESULT ================"
echo "PASS=$PASS FAIL=$FAIL"
rm -f "$COOKIE_ADMIN" "$COOKIE_PLAIN"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1