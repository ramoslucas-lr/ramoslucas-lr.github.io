---
title: "Como vibecodei um banco de dados vetorial que minimiza o uso de RAM"
titleEn: "How I Vibecoded a Vector Database That Minimizes RAM Footprint"
titleEs: "Cómo vibecodeé una base de datos vectorial que minimiza el uso de RAM"
titleFr: "Comment j'ai vibecodé une base de données vectorielle qui minimise l'empreinte RAM"
titleJa: "RAM消費を最小化するベクトルデータベースをバイブコーディングした話"
titleZh: "我是如何用 Vibe Coding 做出一个极低内存占用的向量数据库的"
titleDe: "Wie ich eine Vektordatenbank mit minimalem RAM-Verbrauch gevibecodet habe"
titleRu: "Как я вайбкодил векторную базу данных с минимальным потреблением RAM"
description: "Duas assinaturas de US$ 20/mês, 104 ideias enterradas, worktrees em paralelo no Orca e alguns perrengues de memória em Rust."
descriptionEn: "Two $20/month subscriptions, 104 buried ideas, parallel Orca worktrees, and a few Rust memory lessons."
descriptionEs: "Dos suscripciones de US$ 20/mes, 104 ideas enterradas, worktrees en paralelo en Orca y algunas lecciones de memoria en Rust."
descriptionFr: "Deux abonnements à 20 $/mois, 104 idées enterrées, des worktrees parallèles dans Orca et quelques leçons mémoire en Rust."
descriptionJa: "お使いのブラウザの翻訳ツールをご利用ください。"
descriptionZh: "请使用您的浏览器翻译工具。"
descriptionDe: "Bitte verwenden Sie das Übersetzungstool Ihres Browsers."
descriptionRu: "Пожалуйста, используйте инструмент перевода вашего браузера."
date: 2026-11-23
---

<div class="pt-only">

Se você tentar hospedar por conta própria um milhão de embeddings de 768 dimensões, a memória RAM some rápido.

Só guardar `1.000.000 x 768` floats em `f32` já come uns 2,93 GiB. Aí a maioria dos bancos vetoriais constrói um grafo HNSW em cima disso, mantém listas de vizinhos e metadados na memória e ainda precisa dos vetores sem compressão por perto para recalcular a pontuação final dos resultados. Quando medi um dataset de 1M x 768d (Cohere) em containers isolados, o `pgvector` com HNSW em `f32` bateu 8,5 GiB de pico de RAM, o `Qdrant` HNSW em `f32` chegou a 4,6 GiB e o `Qdrant` INT8 SQ8 em RAM passou de 5,5 GiB. Até o `FAISS` rodando no processo bateu uns 7 GiB.

Eu queria ver até onde dava para espremer o consumo de RAM de um banco vetorial em Rust sem destruir o recall nem a latência. Ao mesmo tempo, eu estava testando uma ideia que vem me incomodando há meses: se LLMs são mesmo o futuro da programação, ou a gente aprende a confiar e colocar código gerado por elas em produção (com os freios certos), ou a gente vai ficar vivendo no passado.

Acabei construindo o [OspreyDB](https://github.com/ospreydb/ospreydb) inteiro usando duas assinaturas de US$ 20/mês — sem pagar conta absurda de API por token — estruturando tanto a descoberta da ideia quanto o desenvolvimento em Rust como pipelines multi-agente bem isolados.

## Como a ideia nasceu: enterrando 104 ideias antes de codar

O OspreyDB não veio de um surto meu de "acho que vou escrever um banco de dados hoje". Ele saiu de outro repositório que eu montei chamado `breakthrough-hunter`, feito justamente para me impedir de gastar semanas construindo projetos aleatórios que ninguém pediu.

A regra básica do `breakthrough-hunter` é zero chamadas pagas de API de LLM dentro dos scripts Python. Os coletores determinísticos (`fetch_papers.py`, `fetch_hn_pain.py`, `fetch_gh_friction.py`) puxam artigos recentes do ArXiv junto com reclamações reais do Hacker News e issues do GitHub para uma fila `frontier_queue.json` travada com `fcntl.flock`, para processos paralelos não corromperem o arquivo.

Depois disso, o processo roda em ondas de quatro sementes, com separação rígida de papéis:

Primeiro entram **4 workers paralelos (`Hydrogen`, `H1` a `H4`)**, cada um preso na sua própria pasta (`inbox/lanes/H1..H4`). Esse isolamento é proposital: evita que a viagem de um agente suje a janela de contexto dos outros. Cada worker cruza o paper ou problema com dores reais de mercado, analisa viabilidade para um dev solo e escreve um dossiê em `staging/ready_for_argon/`.

Depois existe uma **barreira de sincronização** (`--check-barrier`). Nada avança enquanto os quatro `Hydrogen` não entregarem.

Só então entra o **`Argon`**, um único juiz adversarial. Eu cheguei a colocar uma trava hard-coded em Python (`next_seed.py`) que aborta a execução se o `Argon` tentar julgar qualquer semente bruta sem ela ter passado pelos `Hydrogen` antes. A ideia era separar fisicamente quem pesquisa de quem tenta destruir a ideia.

O `Argon` passa cada dossiê por 9 critérios binários de eliminação: armadilhas de marketplace que precisam de rede no dia 1, ciclos longos de venda enterprise, "vitaminas" sem dor financeira, wrappers frágeis de uma única API, software que na prática é consultoria disfarçada, escopo grande demais para uma pessoa e o que eu chamei de "ciência cosmética" (enfiar sigla de paper onde não precisa). Falhou em qualquer um, a ideia morre na hora e vai para o `graveyard.md` com a causa da morte.

Das **114 sementes** que passaram por essa máquina, **104 foram enterradas** e só 10 sobreviveram.

O primeiro lugar (`89/100`) foi uma especificação chamada `S3Vec` (`SEED-002`), juntando três papers (`RemoteANN`, `SuperKMeans` e `WaRP`) sobre quantização RaBitQ e planejamento dinâmico de leituras em S3 para dispensar clusters gigantes de HNSW em RAM. Em quinto (`86/100`) ficou o `LUT-Rank` (`SEED-021`), um reranker em CPU com tabelas minúsculas de 16 entradas rodando direto em instruções SIMD (`vpshufb` / `vtbl`) no lugar de GPUs. Juntar essas duas especificações virou o OspreyDB. (A parte engraçada é que, logo depois dessa leva, eu mesmo pivotei o `breakthrough-hunter` para ideias mais simples de SaaS porque banco de dados continua dando muito trabalho — só que eu teimei e fui construir a semente #1 mesmo assim.)

## Vibecodando com Orca, worktrees em paralelo e US$ 40/mês

Se você abrir um único chat e pedir para um modelo "fazer um banco vetorial em Rust", tudo desmorona lá pelas 2.000 linhas. O contexto enche, o modelo esquece o formato binário que definiu ontem e começa a quebrar um módulo toda vez que mexe em outro.

Para isso funcionar dentro de duas assinaturas de US$ 20/mês, eu trouxe a mesma lógica de isolamento para o código usando o **Orca** com **git worktrees** em paralelo.

Primeiro, congelei os contratos em `RFC-0001`, `RFC-0002` e num `AGENTS.md` com fronteiras rígidas entre crates. O `osprey-core`, por exemplo, não pode fazer nenhum I/O de disco nem de rede. Com os módulos bem separados, nenhum agente precisava carregar o repositório inteiro na cabeça — só a especificação e algumas centenas de linhas de uma crate.

No Orca, quebrei tudo em tasks pequenas rodando ao mesmo tempo em worktrees isoladas: um worker cuidando dos formatos binários alinhados a 64 bytes e da matemática no `osprey-core`, outro escrevendo kernels `AVX-512` e `NEON` no `osprey-simd`, outro montando `memmap2` e `Range-GET` de S3 no `osprey-storage`, e outro levantando a suíte de benchmark em Docker. Como cada um ficava na própria worktree, ninguém pisava no git do outro, e um coordenador revisava os diffs antes de dar merge na `main`.

Usar scripts determinísticos para coleta e travas de fila, modelos mais leves para exploração e testes isolados, e deixar os agentes principais focados em tasks bem recortadas fez tudo caber com folga nas duas assinaturas de US$ 20/mês.

E sobre confiar em código gerado por LLM: confiar não significa fechar o olho e aceitar `unsafe` em Rust. Eu cerquei cada task com travas mecânicas. Lints de workspace proíbem `.unwrap()` em produção; `#[repr(C, align(64))]` com `bytemuck::Pod` e assertions em tempo de compilação derrubam o build se o compilador meter um único byte de padding implícito; e testes diferenciais obrigam cada rotina `AVX-512`, `AVX2` e `NEON` a bater com um loop escalar simples em Rust (`fwht_scalar_in_place` e popcounts escalares).

## Tirando o HNSW da jogada e separando os arquivos

Do lado técnico, quase todo o desperdício de RAM vem de duas coisas: manter um grafo HNSW de ponteiros residente em memória e deixar os vetores sem compressão quentes na RAM para reavaliar os melhores candidatos.

A primeira aposta foi jogar o HNSW fora. Em vez de ficar pulando aleatoriamente pela memória atrás de vizinhos num grafo, o OspreyDB agrupa os vetores com `1-bit Binary K-Means`, reordena os centróides com uma heurística de caixeiro viajante (TSP) para melhorar localidade e faz varreduras sequenciais com SIMD sobre códigos quantizados.

A segunda foi dividir cada conjunto de dados em dois formatos binários separados: o `.osi` guarda apenas o índice quantizado que fica quente em memória, enquanto o `.osv` guarda os vetores exatos em `f16` e os payloads JSON dentro de minipáginas de 16 KB comprimidas com Zstd no disco local ou no S3. Como os vetores exatos ficam comprimidos atrás de uma cache LRU com teto fixo (`--cache-mb`) ou leituras sob demanda no S3, uma busca não sai puxando gigabytes para o page cache do Linux só para recalcular os 20 ou 40 melhores candidatos.

## Por que 4-bit RaBitQ progressivo em vez de quantização binária de 1 bit

Quantização de 1 bit parece ótima na teoria até bater num dataset torto. Nos nossos testes, a quantização binária de 1 bit do `Qdrant` fez 0,96 de `Recall@10` no Cohere 768d e despencou para **0,117** no SIFT1M (128d), porque os vetores do SIFT são todos não-negativos e reduzir tudo ao sinal joga direção demais fora.

Para não cair nisso, o OspreyDB preenche o vetor até a próxima potência de dois (`128 -> 128`, `768 -> 1024`) e aplica uma Transformada Rápida de Walsh-Hadamard ortogonal (`(1 / sqrt(d)) * H_d * D_signs * x`) antes de quantizar. Roda em `O(d log d)` sem precisar guardar matrizes gigantes de rotação, preserva produto interno e espalha a variância entre as dimensões.

Depois disso, ele grava códigos RaBitQ de 4 bits. Em dimensões maiores (`padded_dim >= 512`), esses 4 bits ficam transpostos por plano de bit dentro de cada cluster: na Fase A, a busca lê apenas o bit mais significativo (`b3`, um quarto da banda de memória) via `AVX-512 VPOPCNTDQ`; na Fase B, olha os outros 3 planos (`b2..b0`) só para uma lista curta de candidatos; e no Estágio 2 busca apenas 20 ou 40 vetores `f16` no `.osv` para o cálculo exato. No Cohere 1M x 768d, o índice `.osi` inteiro de 4 bits dá **513,2 MiB**, e o `.osv` em `f16` comprimido com Zstd dá **1.378,7 MiB**.

Como os cabeçalhos e blocos do `.osi` são alinhados a 64 bytes com `bytemuck::Pod`, o `memmap2` mapeia o arquivo direto em slices `&[u64]` sem copiar nada para o heap e entrega tudo alinhado para `vmovdqa64` no AVX-512.

## Quando uma otimização bonita piorou a latência no S3

Uma das melhores partes de medir tudo sem dó é pegar uma ideia que parece genial no papel e ver ela quebrar na prática.

A gente implementou um planejador em Programação Dinâmica (`RangePlanner`) para juntar requisições `Range-GET` próximas no S3 (com lacunas de até 256 KiB) e diminuir o número de idas e vindas pela rede. Testando no MinIO com latência injetada via `tc netem` (`15ms +- 3ms`, RTT real em torno de `16,9 ms`) e cache local zerada (`--cache-mb 0`), isso ajudou bastante na quantização de 1 bit (`1,33x` a `3,30x` menos GETs).

No 4-bit progressivo, saiu pela culatra. Como o filtro de 4 bits já deixa poucos candidatos, o Estágio 2 só precisava de 20 vetores — umas 20 páginas espalhadas de ~10 KB num arquivo de 1,38 GiB. Nesse cenário esparso, o coalescing quase não fundiu nada (caiu de `19,74` para `19,50` GETs), mas esticar a leitura por lacunas de até 256 KiB estourou a janela inicial de congestionamento do TCP e disparou retries especulativos. A latência `P99` de 1 worker disparou de **22,07 ms para 61,98 ms**.

Desligar o coalescing para buscas esparsas em 4 bits fez a latência voltar para **20,26 ms P50 / 22,07 ms P99** com `0,9555` de recall (e `20,49 ms` P50 com `0,9780`), mantendo o processo em torno de **1.066 MiB** de `VmHWM` sem nada de cache local.

## Onde a conta de RAM parou

Para não me enganar nos testes, cada banco no [repositório de benchmarks](https://github.com/ospreydb/benchmarks) rodou sozinho num container num Ryzen 5 7600 (6 cores / 12 threads), reiniciando o container e limpando o page cache do Linux (`dd iflag=nocache count=0`) entre a construção do índice e as queries, medindo `cgroup v2 memory.peak` (ou seja, RSS + page cache somados). Vale o aviso honesto: esse recorte mede busca estática somente leitura de vetor único, sem escritas concorrentes nem filtros de metadados.

No **SIFT1M (1M x 128d)** em `0,95–0,97` de recall, o OspreyDB bateu **382,8 MiB** de pico de RAM (~18–19 mil QPS, `0,37–0,39 ms` P50), entre 3,1x e 6,3x menos RAM que Qdrant e `pgvector`. No **Cohere 1M (1M x 768d)**, ficou em **2.028,3 MiB** (~6,3–8,4 mil QPS, `0,59–0,75 ms` P50), contra 2,9 GiB do `Qdrant SQ8 (on-disk)` (que caiu para `623 QPS` lendo do disco), 3,3 a 5,5 GiB do Qdrant em RAM e 8,5 GiB do `pgvector FP32`. (Outro aviso honesto: o arquivo de teste do Cohere só tem 1.000 queries no total, então os intervalos de confiança de recall se sobrepõem um pouco entre os motores.)

Todo o código está em Apache-2.0 no GitHub (`ospreydb/ospreydb` e `ospreydb/benchmarks`), caso você queira dar uma olhada nas crates, nos RFCs ou rodar o benchmark local.

</div>

<div class="en-only">

If you try to self-host a million 768-dimensional embeddings, RAM disappears fast.

Just storing `1,000,000 x 768` floats in `f32` already eats roughly 2.93 GiB. Then most vector databases build an HNSW graph on top of that, keep neighbor lists and metadata in memory, and still need uncompressed vectors nearby to rescore top results. When I measured a 1M x 768d dataset (Cohere) inside isolated containers, `pgvector` HNSW (`f32`) peaked at 8.5 GiB of RAM, `Qdrant` HNSW (`f32`) hit 4.6 GiB, and `Qdrant` INT8 SQ8 in RAM hit 5.5 GiB. Even in-process `FAISS` peaked around 7 GiB.

I wanted to see how low I could push the RAM footprint of a Rust vector database without ruining recall or latency. At the same time, I was testing an idea that had been bugging me for months: if LLMs really are the future of software, we either learn how to trust and ship code generated by them (with proper guardrails), or we end up living in the past.

I ended up building [OspreyDB](https://github.com/ospreydb/ospreydb) entirely on two $20/month AI subscriptions — zero pay-per-token API bills — by structuring both idea discovery and Rust development as isolated multi-agent pipelines.

## How the idea started: burying 104 ideas first

OspreyDB didn't start with me waking up and deciding to write a database. It came out of another repo I built called `breakthrough-hunter`, designed to stop me from spending weeks building random side projects nobody asked for.

The core rule in `breakthrough-hunter` is zero paid external LLM API calls inside the Python scripts. Deterministic collectors (`fetch_papers.py`, `fetch_hn_pain.py`, `fetch_gh_friction.py`) pull recent ArXiv papers alongside Hacker News complaints and GitHub friction threads into a `frontier_queue.json` file protected by `fcntl.flock`, so parallel workers don't corrupt the queue.

From there, the pipeline runs in waves of four seeds with strict role separation.

First, **4 parallel `Hydrogen` workers (`H1` to `H4`)** grab one seed each inside completely separate directories (`inbox/lanes/H1..H4`). That isolation is intentional: it keeps one agent's rabbit hole from polluting another agent's context window. Each worker cross-references the paper or pain point against real market complaints, checks solo feasibility, and writes a technical dossier to `staging/ready_for_argon/`.

Then comes a **synchronization barrier** (`--check-barrier`). Nothing moves forward until all four `Hydrogen` workers finish.

Only then does **`Argon`** — a single adversarial judge — step in. I even put a hard-coded governance check in Python (`next_seed.py`) that aborts immediately if `Argon` tries to judge a raw seed without it passing through `Hydrogen` first. The whole point was physically separating the researcher from the skeptic.

`Argon` runs every dossier through 9 binary kill criteria: cold-start marketplace traps, 6-month enterprise sales cycles, "vitamins" with no financial urgency, fragile single-API wrappers, disguised consulting, scopes too large for one person, and what I called "cosmetic science" (slapping paper buzzwords onto a problem that doesn't need them). Fail any single one and the idea dies immediately and goes into `graveyard.md` with its cause of death.

Out of **114 seeds** fed into that machine, **104 went to the graveyard** and only 10 survived.

The #1 survivor (`89/100`) was a spec called `S3Vec` (`SEED-002`), combining three papers (`RemoteANN`, `SuperKMeans`, and `WaRP`) around RaBitQ quantization and dynamic S3 range planning to drop RAM-heavy HNSW clusters. At #5 (`86/100`) was `LUT-Rank` (`SEED-021`), a CPU SIMD reranker using tiny 16-entry lookup tables (`vpshufb` / `vtbl`) instead of GPUs. Combining those two became OspreyDB. (The funny part is that right after that batch, I pivoted `breakthrough-hunter` toward simpler SaaS pain points because databases are still brutal to build — and then I stubbornly went ahead and built the #1 seed anyway.)

## Vibecoding with Orca, parallel worktrees, and $40/month

If you open one giant chat window and tell an LLM to "write a Rust vector database," everything falls apart around 2,000 lines. Context fills up, the model forgets yesterday's binary layout, and fixing one module quietly breaks another.

To make it work inside two $20/month subscriptions, I brought the exact same isolation mindset into coding using **Orca** and parallel git **worktrees**.

First, I froze the contracts in `RFC-0001`, `RFC-0002`, and an `AGENTS.md` file with hard crate boundaries. `osprey-core`, for instance, is strictly banned from touching the filesystem or network. With clean crate boundaries, no agent ever needed the entire repo in context — just the spec and a few hundred lines of one crate.

Inside Orca, I split work into small tasks running simultaneously in separate git worktrees: one worker on the 64-byte binary formats and math in `osprey-core`, another writing `AVX-512` and `NEON` kernels in `osprey-simd`, another wiring `memmap2` and S3 `Range-GET`s in `osprey-storage`, and another building the Docker benchmark harness. Because each agent had its own worktree, nobody stepped on anyone else's git state, and a coordinator reviewed diffs before merging to `main`.

Letting deterministic scripts handle scraping and queue locks, lighter runs handle exploration and scoped tests, and main coding agents focus on tight tasks kept everything comfortably inside two $20/month caps.

And trusting LLM-generated code does not mean blindly merging `unsafe` Rust. Every task was boxed in by mechanical checks: workspace lints forbid `.unwrap()` in production, `#[repr(C, align(64))]` plus `bytemuck::Pod` compile-time assertions break the build if a single byte of implicit compiler padding sneaks in, and differential tests force every `AVX-512`, `AVX2`, and `NEON` routine to match a plain scalar Rust loop (`fwht_scalar_in_place` and scalar popcounts).

## Ditching HNSW and splitting the files

On the technical side, most vector DB RAM bloat comes from two habits: keeping an HNSW pointer graph in memory and keeping uncompressed vectors hot in RAM to rescore top candidates.

The first bet was dropping HNSW altogether. Instead of jumping randomly across memory chasing graph neighbors, OspreyDB clusters vectors with `1-bit Binary K-Means`, reorders centroids with a Traveling Salesperson heuristic for spatial locality, and runs sequential SIMD scans over quantized codes.

The second bet was splitting every dataset into two binary files: `.osi` holds only the quantized index meant to stay hot in memory, while `.osv` stores exact `f16` vectors and JSON payloads inside 16 KB Zstd-compressed minipages on local disk or S3. Because exact vectors sit compressed behind a bounded LRU cache (`--cache-mb`) or on-demand S3 `Range-GET`s, queries don't drag gigabytes into the Linux page cache just to rescore 20 or 40 candidates.

## Why 4-bit progressive RaBitQ instead of 1-bit binary quantization

Pure 1-bit quantization looks great on paper until you hit a skewed dataset. In our tests, `Qdrant` 1-bit binary quantization hit 0.96 `Recall@10` on Cohere 768d and then crashed to **0.117** on SIFT1M (128d), because SIFT vectors are non-negative and sign-only bits throw away too much direction.

To avoid that, OspreyDB pads vectors to the next power of two (`128 -> 128`, `768 -> 1024`) and applies an orthogonal Fast Walsh-Hadamard Transform (`(1 / sqrt(d)) * H_d * D_signs * x`) before quantizing. It runs in `O(d log d)` with no huge rotation matrix, preserves inner products, and spreads variance evenly across dimensions.

Then it writes 4-bit RaBitQ codes. For `padded_dim >= 512`, those 4 bits are transposed by bitplane per cluster: Phase A scans only the most significant bitplane (`b3`, one quarter of the memory bandwidth) using `AVX-512 VPOPCNTDQ`, Phase B checks the remaining 3 bitplanes (`b2..b0`) only on a small shortlist, and Stage 2 pulls just 20 or 40 `f16` vectors from `.osv` for exact rescoring. On Cohere 1M x 768d, the whole 4-bit `.osi` index is **513.2 MiB**, and the Zstd-compressed `f16` `.osv` file is **1,378.7 MiB**.

Because `.osi` headers and blocks are 64-byte aligned with `bytemuck::Pod`, `memmap2` maps the file straight into `&[u64]` slices with zero heap copies, feeding aligned `vmovdqa64` loads on AVX-512.

## When a clever S3 optimization backfired

One good thing about measuring everything skeptically is catching ideas that look great in a paper and hurt in practice.

We built a Dynamic Programming range planner (`RangePlanner`) to merge nearby S3 `Range-GET` reads (up to a 256 KiB gap) so queries would make fewer network round-trips. Tested against MinIO with `tc netem` latency (`15ms +- 3ms`, ~`16.9 ms` RTT) and zero local slab cache (`--cache-mb 0`), it worked nicely for 1-bit quantization (`1.33x–3.30x` fewer GETs).

On 4-bit progressive RaBitQ, it backfired. Because 4-bit pruning already leaves a tight shortlist, Stage 2 only needed 20 candidates — around 20 scattered ~10 KB pages across a 1.38 GiB file. At that sparsity, coalescing barely merged anything (`19.74` down to `19.50` GETs), while bridging gaps up to 256 KiB overshot TCP's initial congestion window and triggered hedged retries. Single-worker `P99` latency jumped from **22.07 ms to 61.98 ms**.

Turning coalescing off for sparse 4-bit fetches brought it back down to **20.26 ms P50 / 22.07 ms P99** at `0.9555` recall (and `20.49 ms` P50 at `0.9780`), holding process `VmHWM` around **1,066 MiB** with zero local cache.

## Where the RAM numbers landed

To avoid fooling myself, every engine in the [benchmarks repo](https://github.com/ospreydb/benchmarks) ran solo in a container on a Ryzen 5 7600 (6 cores / 12 threads), restarting containers and flushing the Linux page cache (`dd iflag=nocache count=0`) between index build and queries, measuring `cgroup v2 memory.peak` (RSS + page cache together). One clear caveat: this measures static, read-only single-vector search without concurrent writes or metadata filters.

On **SIFT1M (1M x 128d)** at `0.95–0.97` recall, OspreyDB peaked at **382.8 MiB** of RAM (~18–19k QPS, `0.37–0.39 ms` P50), roughly 3.1x–6.3x less RAM than Qdrant and `pgvector`. On **Cohere 1M (1M x 768d)**, it peaked at **2,028.3 MiB** (~6.3–8.4k QPS, `0.59–0.75 ms` P50), versus 2.9 GiB for `Qdrant SQ8 (on-disk)` (which dropped to `623 QPS` reading from disk), 3.3–5.5 GiB for Qdrant in RAM, and 8.5 GiB for `pgvector FP32`. (Another honest caveat: the Cohere test file only has 1,000 queries total, so recall confidence intervals overlap slightly across engines.)

All of the code is Apache-2.0 on GitHub (`ospreydb/ospreydb` and `ospreydb/benchmarks`) if you want to check the crates, RFCs, or run the local benchmark.

</div>

<div class="es-only">

Si intentas alojar por tu cuenta un millón de embeddings de 768 dimensiones, la memoria RAM desaparece rápido.

Solo almacenar `1.000.000 x 768` floats en `f32` ya consume unos 2,93 GiB. Luego la mayoría de las bases de datos vectoriales construyen un grafo HNSW encima, mantienen listas de vecinos y metadatos en memoria y siguen necesitando vectores sin compresión cerca para recalcular el puntaje final. Cuando medí 1M x 768d (Cohere) en contenedores aislados, `pgvector` HNSW (`f32`) llegó a 8,5 GiB de pico de RAM, `Qdrant` HNSW (`f32`) alcanzó 4,6 GiB y `Qdrant` INT8 SQ8 en RAM llegó a 5,5 GiB. Incluso `FAISS` en proceso llegó a unos 7 GiB.

Quería ver hasta dónde podía reducir el consumo de RAM de una base vectorial en Rust sin arruinar el recall ni la latencia. Al mismo tiempo, quería poner a prueba una idea que me rondaba desde hacía meses: si los LLMs son el futuro del software, o aprendemos a confiar y llevar a producción código generado por ellos (con los controles correctos), o terminaremos viviendo en el pasado.

Terminé construyendo [OspreyDB](https://github.com/ospreydb/ospreydb) con dos suscripciones de US$ 20/mes — sin cuentas de API por token — estructurando tanto la búsqueda de la idea como el desarrollo en Rust en pipelines multiagente aislados.

## Cómo nació la idea: enterrando 104 ideas primero

OspreyDB no surgió de un impulso de "hoy voy a escribir una base de datos". Salió de otro repositorio que armé llamado `breakthrough-hunter`, pensado para evitar pasar semanas construyendo proyectos aleatorios que nadie pidió.

La regla base de `breakthrough-hunter` es cero llamadas pagas a APIs externas de LLM dentro de los scripts Python. Coletores deterministas (`fetch_papers.py`, `fetch_hn_pain.py`, `fetch_gh_friction.py`) traen papers recientes de ArXiv junto con quejas reales de Hacker News e issues de GitHub a una cola `frontier_queue.json` bloqueada con `fcntl.flock`.

A partir de ahí, todo corre en olas de cuatro semillas: **4 workers paralelos (`Hydrogen`, `H1` a `H4`)** aislados en carpetas separadas (`inbox/lanes/H1..H4`) para no contaminar el contexto entre sí, una **barrera de sincronización** (`--check-barrier`) y después un único juez adversarial (**`Argon`**), con una traba en Python (`next_seed.py`) que impide que `Argon` evalúe semillas crudas sin pasar por `Hydrogen`.

`Argon` pasa cada dossier por 9 criterios binarios de eliminación. De **114 semillas**, **104 terminaron en `graveyard.md`** y solo 10 sobrevivieron. El #1 (`89/100`) fue `S3Vec` (`SEED-002`, combinando `RemoteANN`, `SuperKMeans` y `WaRP`) y el #5 (`86/100`) fue `LUT-Rank` (`SEED-021`, reranking en CPU con tablas SIMD de 16 entradas). Juntar esas dos especificaciones se convirtió en OspreyDB.

## Vibecoding con Orca, worktrees paralelas y US$ 40/mes

Pedirle a un solo chat que "escriba una base vectorial en Rust" se rompe alrededor de las 2.000 líneas. Para que funcionara dentro de dos suscripciones de US$ 20/mes, congelé primero los contratos (`RFC-0001`, `RFC-0002`, `AGENTS.md`) con fronteras estrictas entre crates y usé **Orca** con **git worktrees** en paralelo. Un worker trabajaba en `osprey-core`, otro en kernels `AVX-512` / `NEON` en `osprey-simd`, otro en `memmap2` y S3 en `osprey-storage`, y otro en los benchmarks con Docker, sin pisarse en git.

Confiar en código generado por LLMs no significa aceptar `unsafe` a ciegas: lints prohíben `.unwrap()` en producción, `#[repr(C, align(64))]` con `bytemuck::Pod` bloquea cualquier padding implícito al compilar, y tests diferenciales obligan a cada kernel SIMD a coincidir con un loop escalar simple en Rust.

## Quitar HNSW, usar 4-bit RaBitQ progresivo y medir sin autoengaño

OspreyDB elimina el grafo HNSW y separa el almacenamiento en `.osi` (índice cuantizado caliente en memoria) y `.osv` (vectores `f16` exactos y payloads JSON en minipáginas de 16 KB comprimidas con Zstd en disco o S3, detrás de una caché LRU acotada con `--cache-mb`). Antes de cuantizar, aplica una Transformada Rápida de Walsh-Hadamard ortogonal en `O(d log d)` para evitar que distribuciones no negativas como SIFT1M colapsen (donde la cuantización binaria de 1 bit de Qdrant cayó a `0,117` de recall). Luego usa RaBitQ de 4 bits transpuesto por planos de bits: lee primero el bit más significativo (`b3`, un cuarto del ancho de banda) con `AVX-512 VPOPCNTDQ`, refina una lista corta con `b2..b0` y solo trae 20 o 40 vectores `f16` de `.osv`. En 1M x 768d, `.osi` ocupa **513,2 MiB** y `.osv` **1.378,7 MiB**.

También aprendí a desconfiar de optimizaciones bonitas: nuestro planificador DP (`RangePlanner`) para agrupar `Range-GET`s en S3 funcionaba muy bien con 1 bit (`1,33x–3,30x` menos GETs), pero con 4 bits progresivos solo hacían falta ~20 páginas dispersas; cruzar huecos de hasta 256 KiB excedía la ventana inicial de TCP y disparó la latencia `P99` de **22,07 ms a 61,98 ms**. Desactivarlo en lecturas dispersas de 4 bits devolvió **20,26 ms P50 / 22,07 ms P99** con `0,9555` de recall y ~**1.066 MiB** de `VmHWM` sin caché local.

En contenedores aislados (Ryzen 5 7600, limpiando el page cache con `dd iflag=nocache count=0` y midiendo `cgroup v2 memory.peak`, búsqueda estática de solo lectura), OspreyDB alcanzó **382,8 MiB** de RAM en SIFT1M (~18–19k QPS) y **2.028,3 MiB** en Cohere 1M (~6,3–8,4k QPS), frente a 2,9–8,5 GiB en Qdrant y `pgvector`. Todo está bajo Apache-2.0 en `ospreydb/ospreydb` y `ospreydb/benchmarks`.

</div>

<div class="fr-only">

Si vous essayez d'auto-héberger un million d'embeddings de 768 dimensions, la RAM fond vite.

Rien que stocker `1 000 000 x 768` flottants en `f32` prend environ 2,93 Gio. Ensuite, la plupart des bases vectorielles ajoutent un graphe HNSW, des listes de voisins et gardent des vecteurs non compressés en mémoire pour le rescoring. Sur 1M x 768d (Cohere) en conteneurs isolés, `pgvector` HNSW (`f32`) monte à 8,5 Gio de pic RAM, `Qdrant` HNSW (`f32`) à 4,6 Gio et `Qdrant` INT8 SQ8 en RAM à 5,5 Gio. Même `FAISS` en processus approche les 7 Gio.

Je voulais voir jusqu'où réduire l'empreinte RAM d'une base vectorielle en Rust sans casser le recall ni la latence, tout en testant une conviction personnelle : si les LLM sont l'avenir du logiciel, soit on apprend à faire confiance au code qu'ils génèrent (avec de vrais garde-fous), soit on reste bloqué dans le passé.

J'ai fini par construire [OspreyDB](https://github.com/ospreydb/ospreydb) avec deux abonnements à 20 $/mois — sans facture API au token — en structurant la recherche d'idée et le développement Rust en pipelines multi-agents isolés.

## D'où vient l'idée : enterrer 104 idées d'abord

OspreyDB vient d'un autre dépôt, `breakthrough-hunter`, que j'ai créé pour arrêter de passer des semaines sur des projets sans vrai besoin. Des scripts Python déterministes (`fetch_papers.py`, `fetch_hn_pain.py`, `fetch_gh_friction.py`) alimentent une file `frontier_queue.json` verrouillée par `fcntl.flock`, sans aucun appel payant à une API LLM.

Le pipeline tourne par vagues de quatre : **4 workers `Hydrogen` en parallèle** (`H1` à `H4`) isolés dans `inbox/lanes/H1..H4`, une **barrière de synchronisation** (`--check-barrier`), puis un juge adversarial unique (**`Argon`**), avec un verrou Python (`next_seed.py`) empêchant `Argon` de juger une graine brute avant `Hydrogen`. Sur **114 graines**, **104 ont fini dans `graveyard.md`** via 9 critères binaires d'élimination. Le #1 (`89/100`) était `S3Vec` (`RemoteANN`, `SuperKMeans`, `WaRP`) et le #5 (`86/100`) était `LUT-Rank` (reranking CPU SIMD). Fusionner les deux a donné OspreyDB.

## Vibecoder avec Orca, des worktrees parallèles et 40 $/mois

Demander à un seul chat d'écrire une base vectorielle en Rust déraille vite. J'ai figé `RFC-0001`, `RFC-0002` et `AGENTS.md` avec des frontières strictes entre crates (`osprey-core` sans aucun I/O disque ou réseau), puis j'ai découpé les tâches dans **Orca** avec des **git worktrees** parallèles. Les workers avançaient simultanément sur les formats binaires, les kernels `AVX-512`/`NEON`, le stockage `memmap2`/S3 et les benchmarks Docker sans conflits git.

Côté sécurité : zéro `.unwrap()` en production, `#[repr(C, align(64))]` avec `bytemuck::Pod` vérifié à la compilation, et tests différentiels forçant chaque kernel SIMD à correspondre à une boucle scalaire Rust.

## Supprimer HNSW, passer au RaBitQ 4-bit progressif et mesurer honnêtement

OspreyDB abandonne HNSW et sépare `.osi` (index quantifié chaud en mémoire) de `.osv` (vecteurs exacts `f16` et JSON en minipages Zstd de 16 Ko sur disque ou S3, derrière un cache LRU borné `--cache-mb`). Avant de quantifier, une transformée orthogonale de Walsh-Hadamard (`O(d log d)`) évite l'effondrement sur des distributions non négatives comme SIFT1M (où le 1-bit BQ de Qdrant chute à `0,117` de recall). Le RaBitQ 4-bit transposé par plans de bits lit d'abord le bit de poids fort (`b3`, un quart de la bande passante) en `AVX-512 VPOPCNTDQ`, affine une shortlist sur `b2..b0` et ne charge que 20 à 40 vecteurs `f16` depuis `.osv` (`513,2 Mio` pour `.osi` et `1 378,7 Mio` pour `.osv` sur 1M x 768d).

Nos mesures sur MinIO (`tc netem 15ms +- 3ms`, `--cache-mb 0`) ont aussi révélé un piège : la fusion DP des `Range-GET` S3 aide en 1-bit (`1,33x–3,30x` moins de GETs), mais sur les 20 pages éparses du 4-bit progressif elle dépassait la fenêtre TCP initiale et faisait bondir le `P99` de **22,07 ms à 61,98 ms**. La désactiver en mode 4-bit épars a ramené **20,26 ms P50 / 22,07 ms P99** à `0,9555` de recall (`~1 066 Mio` `VmHWM`).

En conteneurs isolés (Ryzen 5 7600, page cache vidé via `dd iflag=nocache count=0`, `cgroup v2 memory.peak`, recherche statique en lecture seule), OspreyDB plafonne à **382,8 Mio** sur SIFT1M (~18–19k QPS) et **2 028,3 Mio** sur Cohere 1M (~6,3–8,4k QPS), contre 2,9 à 8,5 Gio pour Qdrant et `pgvector`. Tout est sous licence Apache-2.0 sur GitHub (`ospreydb/ospreydb` et `ospreydb/benchmarks`).

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
