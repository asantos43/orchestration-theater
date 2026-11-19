# N148 (spike, descartável): qualidade das decisões de um Diretor local no Ollama (127.0.0.1:47510).
# Cada caso é um estado sorteado com semente fixa; a resposta certa sai de regras determinísticas
# que o prompt descreve por inteiro. Mede: JSON válido, ação, demanda e executor certos, e tok/s.
import json, os, random, sys, time, urllib.request

RULES = """Regras, nesta ordem (a primeira que se aplica decide):
1. Se todas as demandas estão "feita": acao "encerrar" (demanda e executor null).
2. Se alguma demanda está "falhou" com 3 tentativas ou mais: acao "escalar" para a de maior prioridade entre elas (executor null).
3. Se alguma demanda está "falhou" com menos de 3 tentativas: acao "repetir" para a de maior prioridade entre elas que tenha executor elegível.
4. Se alguma demanda está "pendente" e todas as dependências dela estão "feita": acao "delegar" para a de maior prioridade entre elas que tenha executor elegível.
5. Senão: acao "aguardar" (demanda e executor null).
Prioridade: número menor = mais prioritária. Demandas "em curso" e "feita" não são escolhidas pelas regras 2 a 4.
Executor elegível para uma demanda: tem a capacidade que a demanda pede, cota usada abaixo de 90%, e, na regra 3, não é o último executor que tentou a demanda. Entre os elegíveis, escolha o de menor cota usada.
Se a regra 3 ou 4 não acha demanda com executor elegível, passe para a regra seguinte."""

KINDS = ["codigo", "docs", "revisao"]
EXECS = {"E1": ("claude", {"codigo", "revisao"}), "E2": ("codex", {"codigo"}),
         "E3": ("opencode", {"codigo", "docs"}), "E4": ("claude", {"docs", "revisao"})}


def make_case(seed):
    rng = random.Random(seed)
    n = rng.randint(5, 8)
    quota = {e: rng.choice([10, 25, 40, 55, 70, 85, 92, 97]) for e in EXECS}
    ds = []
    allow_done_all = seed % 9 == 0
    for i in range(1, n + 1):
        status = "feita" if allow_done_all else rng.choices(
            ["pendente", "em curso", "feita", "falhou"], [4, 2, 2, 2])[0]
        d = {"id": f"D{i}", "prioridade": rng.randint(1, 5), "capacidade": rng.choice(KINDS),
             "estado": status, "tentativas": 0, "ultimo_executor": None,
             "depende_de": [f"D{j}" for j in range(1, i) if rng.random() < 0.2]}
        if status == "falhou":
            d["tentativas"] = rng.choice([1, 2, 2, 3])
            d["ultimo_executor"] = rng.choice(list(EXECS))
        ds.append(d)
    # Prioridades distintas evitam empate.
    for k, p in enumerate(rng.sample(range(1, 20), n)):
        ds[k]["prioridade"] = p
    return ds, quota


def eligible(d, quota, rule3):
    es = [e for e, (_, caps) in EXECS.items() if d["capacidade"] in caps and quota[e] < 90
          and not (rule3 and e == d["ultimo_executor"])]
    return sorted(es, key=lambda e: quota[e])


def expected(ds, quota):
    by = {d["id"]: d for d in ds}
    if all(d["estado"] == "feita" for d in ds):
        return ("encerrar", None, None)
    esc = sorted((d for d in ds if d["estado"] == "falhou" and d["tentativas"] >= 3), key=lambda d: d["prioridade"])
    if esc:
        return ("escalar", esc[0]["id"], None)
    for d in sorted((d for d in ds if d["estado"] == "falhou"), key=lambda d: d["prioridade"]):
        es = eligible(d, quota, True)
        if es:
            return ("repetir", d["id"], es[0])
    for d in sorted((d for d in ds if d["estado"] == "pendente"
                     and all(by[x]["estado"] == "feita" for x in d["depende_de"])), key=lambda d: d["prioridade"]):
        es = eligible(d, quota, False)
        if es:
            return ("delegar", d["id"], es[0])
    return ("aguardar", None, None)


# Histórico longo para encher o contexto (HISTORY_TOKENS, alvo aproximado em tokens; 0 = sem histórico).
# São eventos antigos, já refletidos no estado atual: o modelo tem de decidir pelo estado, não pelo histórico.
HISTORY_TOKENS = int(os.environ.get("HISTORY_TOKENS", "0"))
# Medido em 2026-11-19 com o qwen3:14b: 72 660 caracteres deram 35 612 tokens (~2,0 por token).
CHARS_PER_TOKEN = float(os.environ.get("CHARS_PER_TOKEN", "2.0"))


def history_of(seed):
    if HISTORY_TOKENS <= 0:
        return ""
    rng = random.Random(10_000 + seed)
    acts = ["delegada a", "concluída por", "falhou com", "reatribuída a", "revisada por"]
    notes = ["testes verdes", "lint falhou em dois arquivos", "relatório curto entregue", "cota perto do limite",
             "timeout ao rodar a suíte", "conflito resolvido no CHANGELOG", "pediu mais contexto ao Diretor",
             "PR aberto e CI pendente", "revisão pediu mudanças no tratamento de erro", "worktree limpo"]
    lines, size, n = [], 0, 0
    limit = HISTORY_TOKENS * CHARS_PER_TOKEN
    while size < limit:
        n += 1
        line = (f"- evento {n}: dia {rng.randint(1, 18):02d}/11 {rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}; "
                f"H{rng.randint(1, 60)} {rng.choice(acts)} {rng.choice(list(EXECS))}; "
                f"cota {rng.randint(5, 99)}%; nota: {rng.choice(notes)}")
        lines.append(line); size += len(line) + 1
    return ("Histórico de eventos ANTIGOS (demandas H já encerradas; nada aqui muda o estado atual abaixo):\n"
            + "\n".join(lines) + "\n\n")


def prompt_of(ds, quota, seed=0):
    ex = "\n".join(f"- {e} ({c}): capacidades {', '.join(sorted(caps))}; cota usada {quota[e]}%"
                   for e, (c, caps) in EXECS.items())
    dm = "\n".join(f"- {d['id']}: prioridade {d['prioridade']}; pede {d['capacidade']}; estado {d['estado']}; "
                   f"tentativas {d['tentativas']}; último executor {d['ultimo_executor'] or 'nenhum'}; "
                   f"depende de {', '.join(d['depende_de']) or 'nada'}" for d in ds)
    return ("Você é o Diretor de um sistema de orquestração multi-agente. Decida a próxima ação.\n\n"
            f"{RULES}\n\n{history_of(seed)}Estado atual.\n\nExecutores:\n{ex}\n\nDemandas:\n{dm}\n\n"
            'Responda só com JSON, sem texto antes ou depois: {"acao": "...", "demanda": "Dn" ou null, '
            '"executor": "En" ou null, "motivo": "uma frase"}')


# Contexto: padrão 8K; teto de 32K, o máximo que o desktop do dono suporta (dono, 2026-11-19).
NUM_CTX = int(os.environ.get("NUM_CTX", "8192"))
if not 512 <= NUM_CTX <= 32768:
    sys.exit(f"NUM_CTX={NUM_CTX} fora de 512..32768")


def call(model, prompt):
    opts = {"num_predict": int(os.environ.get("NUM_PREDICT", "200")), "temperature": float(os.environ.get("TEMPERATURE", "0")),
            "num_ctx": NUM_CTX}
    if "NUM_GPU" in os.environ:
        opts["num_gpu"] = int(os.environ["NUM_GPU"])
    body = json.dumps({"model": model, "prompt": prompt, "stream": False, "think": False,
                       "format": "json", "options": opts}).encode()
    req = urllib.request.Request("http://127.0.0.1:47510/api/generate", body, {"Content-Type": "application/json"})
    t = time.time()
    r = json.load(urllib.request.urlopen(req, timeout=1200))
    r["wall"] = time.time() - t
    return r


def main():
    if sys.argv[1] == "--dry":
        from collections import Counter
        print(Counter(expected(*make_case(s))[0] for s in range(int(sys.argv[2]))))
        print(Counter(make_case(s)[0][0]['estado'] for s in range(int(sys.argv[2]))))
        print(prompt_of(*make_case(3)))
        print(expected(*make_case(3)))
        return
    model, per = sys.argv[1], int(sys.argv[2])
    # Casos equilibrados: as primeiras `per` sementes de cada ação esperada.
    seeds, count = [], {}
    for s in range(2000):
        a = expected(*make_case(s))[0]
        if count.get(a, 0) < per:
            count[a] = count.get(a, 0) + 1
            seeds.append(s)
    n = len(seeds)
    ok = {"json": 0, "acao": 0, "demanda": 0, "executor": 0, "tudo": 0}
    walls, rates, ptoks = [], [], []
    for s in seeds:
        ds, q = make_case(s)
        exp = expected(ds, q)
        prompt = prompt_of(ds, q, s)
        r = call(model, prompt)
        walls.append(r["wall"])
        ptoks.append(r.get("prompt_eval_count", 0))
        if r.get("eval_duration"):
            rates.append(r["eval_count"] / (r["eval_duration"] / 1e9))
        try:
            got = json.loads(r["response"])
            g = (got.get("acao"), got.get("demanda"), got.get("executor"))
            ok["json"] += 1
        except Exception:
            g = ("<inválido>", None, None)
        hits = [g[0] == exp[0], g[1] == exp[1], g[2] == exp[2]]
        for k, h in zip(["acao", "demanda", "executor"], hits):
            ok[k] += h
        ok["tudo"] += all(hits)
        pt = r.get("prompt_eval_count", 0)
        # Prompt maior que o contexto: o Ollama corta o começo (as regras) para a METADE do contexto
        # (visto em 2026-11-19: 35 612 tokens viraram 16 386), e o caso não vale. Sem tokenizador no
        # cliente, a pista é a razão: mais de 3,5 caracteres por token contado = parte do prompt sumiu.
        cut = " TRUNCADO" if pt and len(prompt) / pt > 3.5 else ""
        print(f"caso {s:2d}: esperado {exp} obtido {g} {'OK' if all(hits) else 'ERRO'} ({r['wall']:.0f}s, prompt {pt}){cut}",
              flush=True)
    # Descarrega o modelo: nunca dois modelos locais carregados ao mesmo tempo (dono, 2026-11-19).
    body = json.dumps({"model": model, "keep_alive": 0}).encode()
    urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:47510/api/generate", body,
                                                  {"Content-Type": "application/json"}), timeout=120).read()
    rates.sort(); walls.sort(); ptoks.sort()
    print(f"{model}: " + ", ".join(f"{k} {v}/{n}" for k, v in ok.items())
          + f"; geração mediana {rates[len(rates)//2]:.1f} tok/s; parede mediana {walls[len(walls)//2]:.0f}s"
          + f"; prompt mediano {ptoks[len(ptoks)//2]} tokens (máx {ptoks[-1]}); num_ctx {NUM_CTX}"
          + f"; temperatura {os.environ.get('TEMPERATURE', '0')}", flush=True)


main()
