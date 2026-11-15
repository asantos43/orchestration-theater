#!/usr/bin/env python3
"""Medição rápida do spike OpenTUI, dentro do tmux (socket próprio -L otspike).
Uso: scripts/medir.py stream|history|resize [--exe CAMINHO]
- stream: 50 chunks/s por 60 s; amostra RSS e CPU do processo a cada 1 s; mede latência de digitação.
- history: abertura com 5000 mensagens e 1000 passos; RSS/CPU em repouso; rolagem com PageUp.
- resize: redimensiona para 80x24 e 200x60 e confere as bordas pelo capture-pane.
"""
import os, subprocess, sys, time, statistics, json

SOCK = ["tmux", "-L", "otspike"]
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TCK = os.sysconf("SC_CLK_TCK")

def tm(*a, **k):
    return subprocess.run(SOCK + list(a), capture_output=True, text=True, **k).stdout

def pane():
    return tm("capture-pane", "-p", "-t", "m")

def find_pid():
    # processo folha que roda src/main.tsx (ou o executável compilado)
    pid0 = tm("display-message", "-p", "-t", "m", "#{pane_pid}").strip()
    best = None
    def kids(p):
        try:
            return open(f"/proc/{p}/task/{p}/children").read().split()
        except Exception:
            return []
    stack = [pid0]
    while stack:
        p = stack.pop()
        ks = kids(p)
        if not ks:
            best = p
        stack += ks
    return int(best)

def sample(pid):
    st = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
    ticks = int(st[11]) + int(st[12])
    rss = 0
    for l in open(f"/proc/{pid}/status"):
        if l.startswith("VmRSS"):
            rss = int(l.split()[1]) // 1024
    return ticks / TCK, rss

def start(cmd, w=160, h=45):
    tm("kill-session", "-t", "m")
    tm("new-session", "-d", "-s", "m", "-x", str(w), "-y", str(h), f"cd {HERE} && {cmd}; sleep 30")
    t0 = time.time()
    while "◆ ot" not in pane():
        time.sleep(0.02)
        if time.time() - t0 > 20:
            raise SystemExit("TIMEOUT na abertura")
    return time.time() - t0

def latency(n=15):
    out = []
    for i in range(n):
        ch = "qwxzkj"[i % 6] + str(i % 10)
        t = time.time()
        tm("send-keys", "-t", "m", "-l", ch)
        while True:
            p = pane()
            if "› " + ch in p.replace("› Fale com o Orquestrador…", "") or ("›" in p and ch in p.split("›")[-1].split("\n")[0]):
                break
            if time.time() - t > 3:
                out.append(None); break
        else:
            pass
        out.append((time.time() - t) * 1000)
        tm("send-keys", "-t", "m", "BSpace", "BSpace")
        time.sleep(0.15)
    return [x for x in out if x is not None]

def stream(exe):
    cmd = f"{exe} --scenario stream --rate 50 --duration 60" if exe else "bun run start -- --scenario stream --rate 50 --duration 60"
    t_open = start(cmd)
    pid = find_pid()
    c0, _ = sample(pid)
    rows = []
    lat = []
    t0 = time.time()
    for s in range(1, 61):
        time.sleep(max(0, t0 + s - time.time()))
        c, r = sample(pid)
        rows.append((s, round((c - c0) * 100 / 1.0 / 1, 1) if s == 1 else None, r))
        rows[-1] = (s, c, r)
        if s in (10, 30, 50):
            lat += latency(5)
    hdr = pane().split("\n")[0]
    # CPU % por intervalo
    cpu = [(rows[i][1] - (rows[i - 1][1] if i else c0)) * 100 for i in range(len(rows))]
    rss = [r[2] for r in rows]
    print(json.dumps({
        "abertura_s": round(t_open, 2), "pid": pid,
        "cpu_pct_media": round(statistics.mean(cpu), 1), "cpu_pct_p95": round(sorted(cpu)[int(len(cpu) * .95) - 1], 1), "cpu_pct_max": round(max(cpu), 1),
        "rss_mb_ini": rss[0], "rss_mb_fim": rss[-1], "rss_mb_max": max(rss),
        "lat_ms_mediana": round(statistics.median(lat), 0) if lat else None, "lat_ms_max": round(max(lat), 0) if lat else None, "lat_n": len(lat),
        "cabecalho_final": hdr.strip()[-80:],
    }, ensure_ascii=False, indent=1))
    print("RSS por segundo:", rss)
    print("CPU% por segundo:", [round(x) for x in cpu])
    tm("send-keys", "-t", "m", "C-q"); time.sleep(0.5); tm("kill-session", "-t", "m")

def history(exe):
    cmd = f"{exe} --scenario history --messages 5000 --steps 1000" if exe else "bun run start -- --scenario history --messages 5000 --steps 1000"
    t_open = start(cmd)
    pid = find_pid()
    time.sleep(2)
    c0, r0 = sample(pid)
    time.sleep(5)
    c1, r1 = sample(pid)
    print("abertura_s", round(t_open, 2), "RSS_repouso_MB", r1, "CPU_repouso_%", round((c1 - c0) / 5 * 100, 1))
    # rolagem: 200 PageUp no chat e 100 no painel, amostrando RSS
    rs = [r1]
    t = time.time()
    for i in range(200):
        tm("send-keys", "-t", "m", "PageUp")
        if i % 50 == 49: rs.append(sample(pid)[1])
    dt = time.time() - t
    p = pane()
    print("200 PageUp (chat) em", round(dt, 2), "s; RSS ao longo:", rs)
    print("\n".join(p.split("\n")[:6]))
    tm("send-keys", "-t", "m", "Tab")
    for i in range(100):
        tm("send-keys", "-t", "m", "PageUp")
    for i in range(100):
        tm("send-keys", "-t", "m", "PageDown")
    for i in range(300):
        tm("send-keys", "-t", "m", "PageDown")
    c2, r2 = sample(pid)
    print("RSS apos rolagens:", r2)
    # latência de digitação com histórico
    lat = latency(8)
    print("lat_ms_mediana", round(statistics.median(lat)), "max", round(max(lat)), "n", len(lat))
    tm("send-keys", "-t", "m", "C-q"); time.sleep(0.5); tm("kill-session", "-t", "m")

def check_borders(txt, w, h):
    lines = txt.split("\n")
    lines = lines[:h]
    issues = []
    body = lines[1:h - 1]
    # cantos: a linha 1 (após o cabeçalho) deve começar com ╭ e a penúltima terminar com ╯
    if not body[0].startswith("╭"): issues.append("canto sup-esq ausente")
    if not body[-1].rstrip().endswith("╯"): issues.append("canto inf-dir ausente")
    if body[0].count("╭") != body[0].count("╮"): issues.append("╭╮ desiguais")
    if body[-1].count("╰") != body[-1].count("╯"): issues.append("╰╯ desiguais")
    if len(body[0].rstrip()) != w: issues.append(f"largura da linha superior {len(body[0].rstrip())} != {w}")
    for i, l in enumerate(body[1:-1], 1):
        if not l.startswith("│") and not l.startswith("╭"): issues.append(f"linha {i}: sem borda esquerda")
        if len(l.rstrip()) != w: issues.append(f"linha {i}: largura {len(l.rstrip())} != {w}")
    return issues[:8]

def resize(exe):
    cmd = f"{exe} --scenario stream --rate 20 --duration 600" if exe else "bun run start -- --scenario stream --rate 20 --duration 600"
    start(cmd)
    time.sleep(1)
    for (w, h) in [(160, 45), (80, 24), (200, 60), (80, 24), (160, 45)]:
        tm("resize-window", "-t", "m", "-x", str(w), "-y", str(h))
        time.sleep(1.2)
        p = pane()
        lines = p.split("\n")
        iss = check_borders(p, w, h)
        print(f"{w}x{h}: bordas {'OK' if not iss else iss}; linhas={len([l for l in lines if l])}")
        if (w, h) in [(80, 24), (200, 60)]:
            print("\n".join(l for l in lines[:h]))
    tm("send-keys", "-t", "m", "C-q"); time.sleep(0.5); tm("kill-session", "-t", "m")

if __name__ == "__main__":
    mode = sys.argv[1]
    exe = sys.argv[sys.argv.index("--exe") + 1] if "--exe" in sys.argv else None
    {"stream": stream, "history": history, "resize": resize}[mode](exe)
