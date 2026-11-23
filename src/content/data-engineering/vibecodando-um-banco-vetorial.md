---
title: "Como vibecodei um banco de dados vetorial que minimiza o uso de RAM"
titleEn: "How I Vibecoded a Vector Database That Minimizes RAM Footprint"
titleEs: "Cómo vibecodeé una base de datos vectorial que minimiza el uso de RAM"
titleFr: "Comment j'ai vibecodé une base de données vectorielle qui minimise l'empreinte RAM"
titleJa: "RAM消費を最小化するベクトルデータベースをバイブコーディングした話"
titleZh: "我是如何用 Vibe Coding 做出一个极低内存占用的向量数据库的"
titleDe: "Wie ich eine Vektordatenbank mit minimalem RAM-Verbrauch gevibecodet habe"
titleRu: "Как я вайбкодил векторную базу данных с минимальным потреблением RAM"
date: 2026-11-23
technologies:
  - Rust
  - SIMD (AVX-512 / NEON)
  - RaBitQ
  - S3
  - Docker
repoUrl: "https://github.com/ospreydb/ospreydb"
---

<div class="pt-only">

Quem já tentou hospedar por conta própria um milhão de embeddings de 768 dimensões sabe o tamanho da conta de RAM.

Só para segurar `1.000.000 x 768` floats em `f32` já vão 2,93 GiB. Em cima disso, a maioria dos bancos vetoriais ainda sobe um grafo HNSW, guarda listas de vizinhos e metadados na memória e precisa dos vetores sem compressão por perto para recalcular a pontuação final. Quando testei um dataset de 1M x 768d (Cohere) em containers isolados, o `pgvector` com HNSW em `f32` bateu 8,5 GiB de pico de RAM. O `Qdrant` HNSW em `f32` chegou a 4,6 GiB, o `Qdrant` INT8 SQ8 em RAM passou de 5,5 GiB e até o `FAISS` rodando no processo bateu uns 7 GiB.

Eu queria ver até onde dava para baixar esse consumo em Rust sem destruir o recall nem a latência. Também queria tirar a prova de uma cisma minha: se código gerado por LLM vai mesmo virar rotina, preciso descobrir na prática como botar isso de pé com freios de engenharia de verdade, em vez de só ficar gerando snippet solto.

O resultado foi o [OspreyDB](https://github.com/ospreydb/ospreydb), inteiro feito com duas assinaturas de US$ 20/mês (zero conta de API por token), separando tanto a escolha da ideia quanto o código em pipelines com agentes isolados.

## Enterrando 104 ideias antes de escrever uma linha de Rust

O OspreyDB saiu de outro repositório que eu montei, o `breakthrough-hunter`. Fiz ele porque tenho tendência a me empolgar com projeto paralelo aleatório que ninguém pediu e perder semanas nisso.

A regra lá é zero chamadas pagas de API de LLM dentro dos scripts Python. Coletores simples (`fetch_papers.py`, `fetch_hn_pain.py`, `fetch_gh_friction.py`) puxam papers recentes do ArXiv, reclamações do Hacker News e issues do GitHub para uma fila `frontier_queue.json` travada com `fcntl.flock`, para processos paralelos não corromperem o arquivo.

Depois a fila roda em ondas de quatro sementes. Primeiro entram 4 workers paralelos (`Hydrogen`, `H1` a `H4`), cada um preso na sua pasta (`inbox/lanes/H1..H4`). Deixar cada um isolado evita que a viagem de um agente contamine o contexto dos outros. Cada worker cruza o paper ou problema com dores reais de mercado, vê se dá para uma pessoa só construir e joga um dossiê em `staging/ready_for_argon/`.

Quando os quatro terminam (travados por uma barreira `--check-barrier`), entra o `Argon`, um juiz adversarial. Coloquei até uma trava no `next_seed.py` que aborta na hora se o `Argon` tentar avaliar uma semente bruta sem ter passado pelos `Hydrogen`. Quem pesquisa não pode ser quem tenta derrubar a ideia.

O `Argon` passa cada dossiê por 9 critérios binários de corte: marketplace que precisa de rede no dia 1, venda enterprise demorada, "vitamina" sem dor financeira, wrapper de uma API só, consultoria disfarçada de software, escopo grande demais para um dev solo, e o que eu chamei de "ciência cosmética" (enfiar sigla de paper onde um `grep` resolvia). Reprovou em um critério, morre na hora e vai para o `graveyard.md` com o motivo.

Das 114 sementes que rodaram ali, 104 foram para o cemitério e só 10 sobreviveram.

O primeiro lugar (89/100) foi uma spec chamada `S3Vec` (`SEED-002`), juntando três papers (`RemoteANN`, `SuperKMeans` e `WaRP`) sobre quantização RaBitQ e planejamento de leituras no S3 para dispensar HNSW gigante em RAM. Em quinto (86/100) ficou o `LUT-Rank` (`SEED-021`), um reranker em CPU usando tabelas de 16 entradas direto em instruções SIMD (`vpshufb` / `vtbl`). Juntei as duas specs e nasceu o OspreyDB. Detalhe curioso: logo depois dessa leva, eu mesmo mudei o `breakthrough-hunter` para procurar ideias de SaaS mais simples, porque banco de dados dá trabalho demais. Mas acabei teimando e construindo a semente #1 mesmo assim.

## Vibecoding com Orca, worktrees em paralelo e US$ 40/mês

Se você abrir um chat gigante e pedir para um modelo "fazer um banco vetorial em Rust", tudo desanda lá pelas 2.000 linhas. O contexto estoura, o modelo esquece o formato binário que inventou ontem e começa a quebrar um módulo sempre que encosta em outro.

Para caber nas duas assinaturas de US$ 20/mês, levei o mesmo isolamento para o código usando o Orca com git worktrees em paralelo.

Antes de liberar código, congelei os contratos em `RFC-0001`, `RFC-0002` e num `AGENTS.md` com fronteiras rígidas entre crates. A `osprey-core`, por exemplo, é proibida de fazer I/O de disco ou rede. Com os limites travados, nenhum agente precisava carregar o repositório inteiro no contexto, só a spec e algumas centenas de linhas da sua crate.

No Orca, dividi o trabalho em tasks pequenas rodando ao mesmo tempo em worktrees separadas: formatos binários alinhados a 64 bytes e matemática na `osprey-core`, kernels `AVX-512` e `NEON` na `osprey-simd`, `memmap2` e `Range-GET` de S3 na `osprey-storage`, e a suíte de benchmark em Docker. Ninguém pisava no git do outro, e um coordenador revisava os diffs antes de dar merge na `main`. Deixar os coletores e travas em Python determinístico e usar modelos mais leves para exploração e testes isolados fez o limite mensal sobrar.

E aceitar código de LLM não quer dizer fechar o olho para `unsafe` em Rust. Lints de workspace proíbem `.unwrap()` em produção; `#[repr(C, align(64))]` com `bytemuck::Pod` e assertions de compilação derrubam o build se aparecer um único byte de padding implícito. Além disso, testes diferenciais obrigam cada kernel `AVX-512`, `AVX2` e `NEON` a bater exatamente com um loop escalar simples (`fwht_scalar_in_place` e popcounts escalares).

## Tirando o HNSW da jogada e separando os arquivos

Na prática, o desperdício de RAM vem de dois lugares: manter um grafo HNSW cheio de ponteiros na memória e deixar os vetores sem compressão quentes na RAM para reordenar os candidatos.

Resolvi jogar o HNSW fora. Em vez de ficar pulando aleatoriamente pela memória atrás de vizinhos num grafo, o OspreyDB agrupa os vetores com `1-bit Binary K-Means`, reordena os centróides com uma heurística de caixeiro viajante (TSP) para melhorar localidade e varre os códigos quantizados sequencialmente com SIMD.

Também separei cada dataset em dois binários. O `.osi` guarda só o índice quantizado que fica quente em memória. Já o `.osv` guarda os vetores exatos em `f16` e os payloads JSON dentro de minipáginas de 16 KB comprimidas com Zstd no disco local ou no S3. Como os vetores exatos ficam atrás de uma cache LRU com teto fixo (`--cache-mb`) ou são lidos sob demanda no S3, a query não puxa gigabytes para o page cache do Linux só para recalcular os 20 ou 40 melhores resultados.

## Por que 4-bit RaBitQ progressivo em vez de 1 bit

Quantização binária de 1 bit parece ótima até bater num dataset torto. Nos nossos testes, o 1-bit do `Qdrant` fez 0,96 de `Recall@10` no Cohere 768d e despencou para 0,117 no SIFT1M (128d), porque os vetores do SIFT são todos não-negativos e reduzir tudo ao sinal joga direção demais no lixo.

Para não cair nessa armadilha, o OspreyDB preenche o vetor até a próxima potência de dois (`128 -> 128`, `768 -> 1024`) e aplica uma Transformada Rápida de Walsh-Hadamard ortogonal (`(1 / sqrt(d)) * H_d * D_signs * x`) antes de quantizar. Ela roda em `O(d log d)` sem exigir matrizes gigantes de rotação, preserva produto interno e espalha a variância entre as dimensões.

Depois disso, ele grava códigos RaBitQ de 4 bits. Quando `padded_dim >= 512`, esses 4 bits ficam transpostos por plano de bit dentro de cada cluster: na Fase A, a busca lê só o bit mais significativo (`b3`, um quarto da banda de memória) via `AVX-512 VPOPCNTDQ`; na Fase B, olha os outros 3 planos (`b2..b0`) só para uma lista curta de candidatos; e no Estágio 2 busca 20 ou 40 vetores `f16` no `.osv` para o cálculo exato. No Cohere 1M x 768d, o índice `.osi` inteiro de 4 bits dá 513,2 MiB, e o `.osv` em `f16` comprimido com Zstd dá 1.378,7 MiB.

Como os cabeçalhos e blocos do `.osi` são alinhados a 64 bytes com `bytemuck::Pod`, o `memmap2` mapeia o arquivo direto em slices `&[u64]` sem copiar nada para o heap e entrega tudo alinhado para `vmovdqa64` no AVX-512.

## Quando uma otimização bonita piorou a latência no S3

Medir tudo sem dó serve justamente para pegar ideia que parece genial no papel e quebra na rede.

A gente implementou um planejador em Programação Dinâmica (`RangePlanner`) para juntar requisições `Range-GET` próximas no S3 (com lacunas de até 256 KiB) e cortar idas e vindas pela rede. Testando no MinIO com latência injetada via `tc netem` (`15ms +- 3ms`, RTT real em torno de `16,9 ms`) e cache local zerada (`--cache-mb 0`), isso funcionou muito bem no 1-bit (`1,33x` a `3,30x` menos GETs).

No 4-bit progressivo, saiu pela culatra. Como o filtro de 4 bits já deixa poucos candidatos, o Estágio 2 só precisava de 20 vetores, que davam umas 20 páginas espalhadas de ~10 KB num arquivo de 1,38 GiB. Nesse cenário esparso, o coalescing quase não fundiu nada (caiu de `19,74` para `19,50` GETs), mas esticar a leitura por lacunas de até 256 KiB estourou a janela inicial de congestionamento do TCP e disparou retries especulativos. A latência `P99` de 1 worker saltou de 22,07 ms para 61,98 ms.

Desligar o coalescing para buscas esparsas em 4 bits fez a latência voltar para 20,26 ms P50 / 22,07 ms P99 com `0,9555` de recall (e `20,49 ms` P50 com `0,9780`), mantendo o processo em torno de 1.066 MiB de `VmHWM` sem cache local.

## Onde a conta de RAM parou

Cada banco no [repositório de benchmarks](https://github.com/ospreydb/benchmarks) rodou sozinho num container num Ryzen 5 7600 (6 cores / 12 threads), reiniciando o container e limpando o page cache do Linux (`dd iflag=nocache count=0`) entre a construção do índice e as queries. A métrica foi `cgroup v2 memory.peak` (RSS + page cache somados). Vale notar que esse teste mede busca estática somente leitura de vetor único, sem escritas concorrentes nem filtros de metadados.

No SIFT1M (1M x 128d) em `0,95–0,97` de recall, o OspreyDB bateu 382,8 MiB de pico de RAM (~18–19 mil QPS, `0,37–0,39 ms` P50), entre 3,1x e 6,3x menos RAM que Qdrant e `pgvector`. No Cohere 1M (1M x 768d), ficou em 2.028,3 MiB (~6,3–8,4 mil QPS, `0,59–0,75 ms` P50), contra 2,9 GiB do `Qdrant SQ8 (on-disk)` (que caiu para `623 QPS` lendo do disco), 3,3 a 5,5 GiB do Qdrant em RAM e 8,5 GiB do `pgvector FP32`. Um detalhe do dataset: o arquivo de teste do Cohere só tem 1.000 queries ao todo, então os intervalos de confiança de recall acabam se sobrepondo um pouco entre os motores.

O código e a suíte de benchmarks estão no GitHub sob licença Apache-2.0 (`ospreydb/ospreydb` e `ospreydb/benchmarks`).

</div>

<div class="en-only">

If you try to self-host a million 768-dimensional embeddings, RAM disappears fast.

Just holding `1,000,000 x 768` floats in `f32` already takes 2.93 GiB. On top of that, most vector databases build an HNSW graph, keep neighbor lists and metadata in memory, and still need uncompressed vectors nearby to rescore top results. When I measured a 1M x 768d dataset (Cohere) inside isolated containers, `pgvector` HNSW (`f32`) peaked at 8.5 GiB of RAM. `Qdrant` HNSW (`f32`) hit 4.6 GiB, `Qdrant` INT8 SQ8 in RAM passed 5.5 GiB, and in-process `FAISS` peaked around 7 GiB.

I wanted to see how far I could shrink that footprint in Rust without wrecking recall or latency. At the same time, I wanted to test a practical question: if LLM-generated code is going to be part of daily engineering, how do you actually ship a non-trivial system with it using real mechanical guardrails instead of praying over a giant chat window?

The result is [OspreyDB](https://github.com/ospreydb/ospreydb), built on two $20/month AI subscriptions (zero pay-per-token API bills) by splitting both idea selection and Rust development into isolated agent pipelines.

## Burying 104 ideas before writing any Rust

OspreyDB came out of another repo I built called `breakthrough-hunter`. I wrote it to stop myself from getting excited about random side projects nobody asked for and losing weeks on them.

The basic rule in `breakthrough-hunter` is zero paid LLM API calls inside the Python scripts. Simple collectors (`fetch_papers.py`, `fetch_hn_pain.py`, `fetch_gh_friction.py`) pull recent ArXiv papers, Hacker News complaints, and GitHub friction threads into a `frontier_queue.json` file locked with `fcntl.flock` so parallel workers don't corrupt it.

From there, the queue runs in waves of four seeds. First, 4 parallel `Hydrogen` workers (`H1` to `H4`) grab one seed each inside separate folders (`inbox/lanes/H1..H4`). Keeping them isolated stops one agent's tangent from polluting another agent's context. Each worker cross-references the paper or pain point with real market complaints, checks solo feasibility, and writes a dossier to `staging/ready_for_argon/`.

Once all four finish (enforced by `--check-barrier`), a single adversarial judge called `Argon` takes over. I even put a hard check in `next_seed.py` that aborts immediately if `Argon` tries to judge a raw seed without it passing through `Hydrogen` first. Whoever does the research shouldn't be the same process trying to kill the idea.

`Argon` runs each dossier through 9 binary kill criteria: cold-start marketplace traps, slow enterprise sales cycles, "vitamins" with no financial urgency, fragile single-API wrappers, disguised consulting, scopes too big for one person, and what I called "cosmetic science" (slapping paper buzzwords onto something a `grep` could solve). Fail any single one and the idea goes straight to `graveyard.md` with its cause of death.

Out of 114 seeds fed into that machine, 104 ended up in the graveyard and only 10 survived.

The #1 survivor (89/100) was a spec called `S3Vec` (`SEED-002`), combining three papers (`RemoteANN`, `SuperKMeans`, and `WaRP`) around RaBitQ quantization and S3 range planning to drop RAM-heavy HNSW clusters. At #5 (86/100) was `LUT-Rank` (`SEED-021`), a CPU SIMD reranker using tiny 16-entry lookup tables (`vpshufb` / `vtbl`). Combining the two became OspreyDB. Funny enough, right after that batch I pivoted `breakthrough-hunter` toward simpler SaaS pain points because databases are brutal to build, and then stubbornly went ahead and built seed #1 anyway.

## Vibecoding with Orca, parallel worktrees, and $40/month

If you open one giant chat and tell an LLM to "write a Rust vector database," everything falls apart around 2,000 lines. Context fills up, the model forgets yesterday's binary layout, and fixing one module quietly breaks another.

To stay inside two $20/month subscriptions, I brought the same isolation mindset into coding using Orca and parallel git worktrees.

Before writing code, I froze the contracts in `RFC-0001`, `RFC-0002`, and an `AGENTS.md` file with strict crate boundaries. `osprey-core`, for example, is banned from touching the filesystem or network. With tight boundaries, no agent ever needed the whole repo in context, just the spec and a few hundred lines of its own crate.

In Orca, I split work into small tasks running simultaneously in separate git worktrees: 64-byte binary formats and math in `osprey-core`, `AVX-512` and `NEON` kernels in `osprey-simd`, `memmap2` and S3 `Range-GET`s in `osprey-storage`, and the Docker benchmark suite. Nobody stepped on anyone else's git state, and a coordinator reviewed diffs before merging to `main`. Keeping scraping and locks in deterministic Python and using lighter runs for exploration and scoped tests left plenty of headroom inside both $20/month caps.

Accepting LLM code doesn't mean blindly merging `unsafe` Rust. Workspace lints forbid `.unwrap()` in production, `#[repr(C, align(64))]` with `bytemuck::Pod` compile-time assertions break the build if a single byte of implicit padding sneaks in, and differential tests force every `AVX-512`, `AVX2`, and `NEON` routine to match a plain scalar Rust loop (`fwht_scalar_in_place` and scalar popcounts).

## Ditching HNSW and splitting the files

In practice, RAM bloat comes from two habits: keeping an HNSW pointer graph in memory and keeping uncompressed vectors hot in RAM to rescore top candidates.

So I dropped HNSW altogether. Instead of jumping randomly across memory chasing graph neighbors, OspreyDB clusters vectors with `1-bit Binary K-Means`, reorders centroids with a Traveling Salesperson heuristic for locality, and runs sequential SIMD scans over quantized codes.

I also split each dataset into two binary files. `.osi` holds only the quantized index meant to stay hot in memory. `.osv` stores exact `f16` vectors and JSON payloads inside 16 KB Zstd-compressed minipages on local disk or S3. Because exact vectors sit behind a bounded LRU cache (`--cache-mb`) or on-demand S3 `Range-GET`s, queries don't drag gigabytes into the Linux page cache just to rescore 20 or 40 candidates.

## Why 4-bit progressive RaBitQ instead of 1-bit binary quantization

Pure 1-bit quantization looks great until you hit a skewed dataset. In our tests, `Qdrant` 1-bit binary quantization hit 0.96 `Recall@10` on Cohere 768d and then crashed to 0.117 on SIFT1M (128d), because SIFT vectors are non-negative and sign-only bits throw away too much direction.

To avoid that, OspreyDB pads vectors to the next power of two (`128 -> 128`, `768 -> 1024`) and applies an orthogonal Fast Walsh-Hadamard Transform (`(1 / sqrt(d)) * H_d * D_signs * x`) before quantizing. It runs in `O(d log d)` without storing giant rotation matrices, preserves inner products, and spreads variance across dimensions.

Then it writes 4-bit RaBitQ codes. For `padded_dim >= 512`, those 4 bits are transposed by bitplane per cluster: Phase A scans only the most significant bitplane (`b3`, one quarter of the memory bandwidth) using `AVX-512 VPOPCNTDQ`, Phase B checks the remaining 3 bitplanes (`b2..b0`) on a shortlist, and Stage 2 pulls 20 or 40 `f16` vectors from `.osv` for exact rescoring. On Cohere 1M x 768d, the whole 4-bit `.osi` index is 513.2 MiB, and the Zstd-compressed `f16` `.osv` file is 1,378.7 MiB.

Because `.osi` headers and blocks are 64-byte aligned with `bytemuck::Pod`, `memmap2` maps the file straight into `&[u64]` slices with zero heap copies, feeding aligned `vmovdqa64` loads on AVX-512.

## When a clever S3 optimization backfired

Measuring everything skeptically is mostly about catching ideas that look great on paper and break on the network.

We built a Dynamic Programming range planner (`RangePlanner`) to merge nearby S3 `Range-GET` reads (up to a 256 KiB gap) and cut network round-trips. Tested against MinIO with `tc netem` latency (`15ms +- 3ms`, ~`16.9 ms` RTT) and zero local cache (`--cache-mb 0`), it worked nicely for 1-bit quantization (`1.33x–3.30x` fewer GETs).

On 4-bit progressive RaBitQ, it backfired. Because 4-bit pruning already leaves a tight shortlist, Stage 2 only needed 20 candidates, which meant ~20 scattered 10 KB pages across a 1.38 GiB file. At that sparsity, coalescing barely merged anything (`19.74` down to `19.50` GETs), while bridging gaps up to 256 KiB overshot TCP's initial congestion window and triggered hedged retries. Single-worker `P99` latency jumped from 22.07 ms to 61.98 ms.

Turning coalescing off for sparse 4-bit fetches brought latency back down to 20.26 ms P50 / 22.07 ms P99 at `0.9555` recall (and `20.49 ms` P50 at `0.9780`), holding process `VmHWM` around 1,066 MiB with zero local cache.

## Where the RAM numbers landed

Every engine in the [benchmarks repo](https://github.com/ospreydb/benchmarks) ran solo in a container on a Ryzen 5 7600 (6 cores / 12 threads), restarting containers and flushing the Linux page cache (`dd iflag=nocache count=0`) between index build and queries, measuring `cgroup v2 memory.peak` (RSS + page cache together). One caveat: this measures static, read-only single-vector search without concurrent writes or metadata filters.

On SIFT1M (1M x 128d) at `0.95–0.97` recall, OspreyDB peaked at 382.8 MiB of RAM (~18–19k QPS, `0.37–0.39 ms` P50), roughly 3.1x–6.3x less RAM than Qdrant and `pgvector`. On Cohere 1M (1M x 768d), it peaked at 2,028.3 MiB (~6.3–8.4k QPS, `0.59–0.75 ms` P50), versus 2.9 GiB for `Qdrant SQ8 (on-disk)` (which dropped to `623 QPS` reading from disk), 3.3–5.5 GiB for Qdrant in RAM, and 8.5 GiB for `pgvector FP32`. Worth noting: the Cohere test file only has 1,000 queries total, so recall confidence intervals overlap slightly across engines.

Both the database and the benchmark suite are Apache-2.0 on GitHub (`ospreydb/ospreydb` and `ospreydb/benchmarks`).

</div>

<div class="es-only">

Quien ha intentado alojar por su cuenta un millón de embeddings de 768 dimensiones sabe lo rápido que se va la memoria RAM.

Solo almacenar `1.000.000 x 768` floats en `f32` ya consume 2,93 GiB. Encima de eso, la mayoría de las bases vectoriales construyen un grafo HNSW, guardan listas de vecinos y metadatos en memoria y siguen necesitando vectores sin compresión cerca para recalcular el puntaje final. Cuando medí 1M x 768d (Cohere) en contenedores aislados, `pgvector` HNSW (`f32`) llegó a 8,5 GiB de pico de RAM. `Qdrant` HNSW (`f32`) alcanzó 4,6 GiB, `Qdrant` INT8 SQ8 en RAM pasó de 5,5 GiB e incluso `FAISS` en proceso llegó a unos 7 GiB.

Quería ver hasta dónde podía bajar ese consumo en Rust sin arruinar el recall ni la latencia, y de paso comprobar en la práctica cómo llevar a producción código generado por LLMs con controles mecánicos reales. El resultado fue [OspreyDB](https://github.com/ospreydb/ospreydb), construido con dos suscripciones de US$ 20/mes (cero facturas de API por token), separando tanto la búsqueda de la idea como el desarrollo en pipelines con agentes aislados.

## Enterrando 104 ideas antes de escribir Rust

OspreyDB salió de otro repositorio que armé, `breakthrough-hunter`, pensado para evitar entusiasmarme con proyectos aleatorios que nadie pidió y perder semanas en ellos.

La regla ahí es cero llamadas pagas a APIs de LLM dentro de los scripts Python. Coletores simples (`fetch_papers.py`, `fetch_hn_pain.py`, `fetch_gh_friction.py`) traen papers de ArXiv, quejas de Hacker News e issues de GitHub a una cola `frontier_queue.json` bloqueada con `fcntl.flock`.

Después la cola corre en olas de cuatro semillas: 4 workers paralelos (`Hydrogen`, `H1` a `H4`) aislados en carpetas separadas (`inbox/lanes/H1..H4`) para que no se contaminen el contexto, una barrera (`--check-barrier`) y después un único juez adversarial (`Argon`), con una traba en `next_seed.py` que aborta si `Argon` intenta evaluar una semilla cruda sin haber pasado por `Hydrogen`.

`Argon` pasa cada dossier por 9 criterios binarios de corte. De 114 semillas, 104 terminaron en `graveyard.md` y solo 10 sobrevivieron. El #1 (89/100) fue `S3Vec` (`SEED-002`, combinando `RemoteANN`, `SuperKMeans` y `WaRP`) y el #5 (86/100) fue `LUT-Rank` (`SEED-021`, reranking en CPU con tablas SIMD de 16 entradas). Juntar las dos especificaciones se convirtió en OspreyDB.

## Vibecoding con Orca, worktrees paralelas y US$ 40/mes

Pedirle a un solo chat que "escriba una base vectorial en Rust" se rompe alrededor de las 2.000 líneas. Para mantenerme dentro de dos suscripciones de US$ 20/mes, congelé primero los contratos (`RFC-0001`, `RFC-0002`, `AGENTS.md`) con fronteras estrictas entre crates (`osprey-core` tiene prohibido tocar disco o red) y usé Orca con git worktrees en paralelo: formatos binarios y matemática en `osprey-core`, kernels `AVX-512` / `NEON` en `osprey-simd`, `memmap2` y S3 en `osprey-storage`, y benchmarks en Docker, sin pisarse en git.

Aceptar código de LLM no significa aceptar `unsafe` a ciegas: lints prohíben `.unwrap()` en producción, `#[repr(C, align(64))]` con `bytemuck::Pod` rompe la compilación si aparece un byte de padding implícito, y tests diferenciales obligan a cada kernel SIMD a coincidir con un loop escalar simple en Rust.

## Quitar HNSW, usar 4-bit RaBitQ progresivo y medir de verdad

OspreyDB elimina el grafo HNSW y separa cada dataset en `.osi` (índice quantizado caliente en memoria) y `.osv` (vectores `f16` exactos y payloads JSON en minipáginas de 16 KB comprimidas con Zstd en disco o S3, detrás de una caché LRU acotada con `--cache-mb`). Antes de cuantizar, aplica una Transformada Rápida de Walsh-Hadamard ortogonal en `O(d log d)` para evitar que distribuciones no negativas como SIFT1M colapsen (donde la cuantización de 1 bit de Qdrant cayó a `0,117` de recall). Luego usa RaBitQ de 4 bits transpuesto por planos de bits: lee primero `b3` con `AVX-512 VPOPCNTDQ`, refina una lista corta con `b2..b0` y solo trae 20 o 40 vectores `f16` de `.osv`. En 1M x 768d, `.osi` ocupa 513,2 MiB y `.osv` 1.378,7 MiB.

Medir todo también sirvió para pillar una optimización que empeoraba las cosas: nuestro planificador DP (`RangePlanner`) para agrupar `Range-GET`s en S3 ayudaba mucho con 1 bit (`1,33x–3,30x` menos GETs), pero con 4 bits progresivos solo hacían falta ~20 páginas dispersas; cruzar huecos de hasta 256 KiB excedía la ventana inicial de TCP y disparó la latencia `P99` de 22,07 ms a 61,98 ms. Desactivarlo en lecturas dispersas de 4 bits devolvió 20,26 ms P50 / 22,07 ms P99 con `0,9555` de recall y ~1.066 MiB de `VmHWM` sin caché local.

En contenedores aislados (Ryzen 5 7600, limpiando el page cache con `dd iflag=nocache count=0` y midiendo `cgroup v2 memory.peak`, búsqueda estática de solo lectura), OspreyDB alcanzó 382,8 MiB de RAM en SIFT1M (~18–19k QPS) y 2.028,3 MiB en Cohere 1M (~6,3–8,4k QPS), frente a 2,9–8,5 GiB en Qdrant y `pgvector`. El código y los benchmarks están bajo Apache-2.0 en `ospreydb/ospreydb` y `ospreydb/benchmarks`.

</div>

<div class="fr-only">

Quiconque a déjà essayé d'auto-héberger un million d'embeddings de 768 dimensions sait à quelle vitesse la RAM part en fumée.

Rien que stocker `1 000 000 x 768` flottants en `f32` prend 2,93 Gio. Là-dessus, la plupart des bases vectorielles ajoutent un graphe HNSW, des listes de voisins et gardent des vecteurs non compressés en mémoire pour le rescoring. Sur 1M x 768d (Cohere) en conteneurs isolés, `pgvector` HNSW (`f32`) monte à 8,5 Gio de pic RAM, `Qdrant` HNSW (`f32`) à 4,6 Gio, `Qdrant` INT8 SQ8 en RAM à 5,5 Gio et `FAISS` en processus approche les 7 Gio.

Je voulais voir jusqu'où réduire cette empreinte en Rust sans casser le recall ni la latence, tout en testant concrètement comment livrer du code généré par LLM avec de vrais garde-fous mécaniques. Le résultat est [OspreyDB](https://github.com/ospreydb/ospreydb), construit avec deux abonnements à 20 $/mois (zéro facture API au token), en isolant la recherche d'idée comme le code dans des pipelines multi-agents.

## Enterrer 104 idées avant d'écrire du Rust

OspreyDB vient d'un autre dépôt, `breakthrough-hunter`, que j'ai créé pour m'éviter de partir sur des projets parallèles dont personne ne veut. Des scripts Python déterministes (`fetch_papers.py`, `fetch_hn_pain.py`, `fetch_gh_friction.py`) alimentent une file `frontier_queue.json` verrouillée par `fcntl.flock`, sans appel payant à une API LLM.

La file tourne par vagues de quatre : 4 workers `Hydrogen` en parallèle (`H1` à `H4`) isolés dans `inbox/lanes/H1..H4`, une barrière (`--check-barrier`), puis un juge adversarial unique (`Argon`), avec un verrou dans `next_seed.py` empêchant `Argon` d'évaluer une graine brute avant `Hydrogen`. Sur 114 graines, 104 ont fini dans `graveyard.md` via 9 critères binaires d'élimination. Le #1 (89/100) était `S3Vec` (`RemoteANN`, `SuperKMeans`, `WaRP`) et le #5 (86/100) était `LUT-Rank` (reranking CPU SIMD). Fusionner les deux a donné OspreyDB.

## Vibecoder avec Orca, des worktrees parallèles et 40 $/mois

Demander à un seul chat d'écrire une base vectorielle en Rust déraille vite. J'ai figé `RFC-0001`, `RFC-0002` et `AGENTS.md` avec des frontières strictes entre crates (`osprey-core` sans I/O disque ni réseau), puis j'ai découpé les tâches dans Orca avec des git worktrees parallèles sur les formats binaires, les kernels `AVX-512`/`NEON`, le stockage `memmap2`/S3 et les benchmarks Docker sans conflits git.

Côté sécurité : zéro `.unwrap()` en production, `#[repr(C, align(64))]` avec `bytemuck::Pod` vérifié à la compilation, et tests différentiels forçant chaque kernel SIMD à correspondre à une boucle scalaire Rust.

## Supprimer HNSW, passer au RaBitQ 4-bit progressif et mesurer honnêtement

OspreyDB abandonne HNSW et sépare `.osi` (index quantifié chaud en mémoire) de `.osv` (vecteurs exacts `f16` et JSON en minipages Zstd de 16 Ko sur disque ou S3, derrière un cache LRU borné `--cache-mb`). Avant de quantifier, une transformée orthogonale de Walsh-Hadamard (`O(d log d)`) évite l'effondrement sur des distributions non négatives comme SIFT1M (où le 1-bit BQ de Qdrant chute à `0,117` de recall). Le RaBitQ 4-bit transposé par plans de bits lit d'abord `b3` en `AVX-512 VPOPCNTDQ`, affine une shortlist sur `b2..b0` et ne charge que 20 à 40 vecteurs `f16` depuis `.osv` (`513,2 Mio` pour `.osi` et `1 378,7 Mio` pour `.osv` sur 1M x 768d).

Nos mesures sur MinIO (`tc netem 15ms +- 3ms`, `--cache-mb 0`) ont aussi montré un piège : la fusion DP des `Range-GET` S3 aide en 1-bit (`1,33x–3,30x` moins de GETs), mais sur les 20 pages éparses du 4-bit progressif elle dépassait la fenêtre TCP initiale et faisait bondir le `P99` de 22,07 ms à 61,98 ms. La désactiver en mode 4-bit épars a ramené 20,26 ms P50 / 22,07 ms P99 à `0,9555` de recall (`~1 066 Mio` `VmHWM`).

En conteneurs isolés (Ryzen 5 7600, page cache vidé via `dd iflag=nocache count=0`, `cgroup v2 memory.peak`, recherche statique en lecture seule), OspreyDB plafonne à 382,8 Mio sur SIFT1M (~18–19k QPS) et 2 028,3 Mio sur Cohere 1M (~6,3–8,4k QPS), contre 2,9 à 8,5 Gio pour Qdrant et `pgvector`. Le tout est sous licence Apache-2.0 sur GitHub (`ospreydb/ospreydb` et `ospreydb/benchmarks`).

</div>

<div class="ja-only">
お使いのブラウザの翻訳ツールをご利用ください。
</div>

<div class="zh-only">
请使用您的浏览器翻译工具。
</div>

<div class="de-only">
Bitte verwenden Sie das Übersetzungstool Ihres Browsers.
</div>

<div class="ru-only">
Пожалуйста, используйте инструмент перевода вашего браузера.
</div>
