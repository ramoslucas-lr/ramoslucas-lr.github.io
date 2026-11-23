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

Só os números crus já ocupam quase 3 GiB. Em cima disso, a maioria dos bancos vetoriais ainda mantém um grafo gigante na memória para navegar entre vizinhos, guarda metadados e precisa dos vetores originais por perto para conferir o resultado final. Quando rodei um teste com um milhão de vetores (do dataset Cohere) em containers isolados, o pgvector bateu 8,5 GiB de pico de RAM. O Qdrant chegou entre 4,6 e 5,5 GiB, e até o FAISS rodando direto no processo bateu uns 7 GiB.

Eu queria ver até onde dava para baixar esse consumo em Rust sem destruir a qualidade nem a velocidade da busca. Ao mesmo tempo, queria tirar a prova de uma cisma minha: se programar com LLM vai mesmo virar rotina, como é que dá para tocar um projeto inteiro assim sem virar bagunça?

O resultado foi o [OspreyDB](https://github.com/ospreydb/ospreydb), construído usando duas assinaturas de US$ 20/mês (sem pagar conta de API por token), separando tanto a escolha da ideia quanto o desenvolvimento em etapas bem isoladas.

## Enterrando 104 ideias antes de escrever uma linha de Rust

O OspreyDB saiu de outro projeto que montei, o breakthrough-hunter. Fiz ele porque tenho tendência a me empolgar com ideia aleatória que ninguém pediu e perder semanas codando coisa inútil.

A regra lá é não gastar nada com API externa de IA nos scripts de coleta. Uns scripts simples em Python puxam papers recentes do ArXiv, reclamações do Hacker News e issues do GitHub para uma fila única.

Depois a fila roda em levas de quatro ideias por vez. Primeiro entram 4 agentes em paralelo, cada um trancado na sua própria pasta para que a viagem de um não suje a cabeça do outro. Cada um cruza o paper ou problema com dores reais de mercado, vê se dá para uma pessoa só construir e escreve um dossiê.

Quando os quatro terminam, entra um único juiz do contra, que chamei de Argon. Coloquei até uma trava no código que impede o juiz de avaliar qualquer ideia crua antes de ela passar pelos quatro pesquisadores. Quem pesquisa não pode ser quem tenta derrubar a ideia.

Esse juiz passa cada dossiê por 9 filtros eliminatórios bem duros: marketplace que precisa de gente dos dois lados no dia 1, venda corporativa demorada, projetinho bonito mas que não resolve dor nenhuma, wrapper de uma API só, consultoria disfarçada de software, escopo grande demais para um dev solo, e o que chamei de "ciência cosmética" (enfiar jargão de artigo científico onde uma busca simples resolvia). Reprovou em um filtro, a ideia morre na hora e vai para um arquivo de cemitério com a causa da morte.

Das 114 ideias que passaram por essa máquina, 104 foram enterradas e só 10 sobreviveram.

O primeiro lugar (89/100) juntava ideias de quantização compacta e leitura sob demanda no S3 para não depender de grafos pesados na RAM. Em quinto (86/100) ficou um esquema de reordenação rápida direto na CPU, sem precisar de GPU. Juntei as duas propostas e nasceu o OspreyDB. Detalhe curioso: logo depois dessa leva, eu mesmo mudei o caçador de ideias para procurar SaaS mais simples, porque banco de dados dá trabalho demais. Mas acabei teimando e construindo a ideia #1 mesmo assim.

## Vibecoding com Orca, branches em paralelo e US$ 40/mês

Se você abrir um chat gigante e pedir para um modelo "fazer um banco vetorial em Rust", tudo desanda lá pelas 2.000 linhas. O contexto estoura, o modelo esquece o formato de arquivo que inventou ontem e começa a quebrar uma parte sempre que encosta em outra.

Para caber nas duas assinaturas de US$ 20/mês, levei o mesmo isolamento para o código usando o Orca com várias worktrees do git rodando ao mesmo tempo.

Antes de liberar código, escrevi as regras do jogo e os contratos entre cada módulo. O núcleo matemático, por exemplo, é proibido de encostar em disco ou rede. Com esses limites travados, nenhum agente precisava carregar o projeto inteiro na cabeça, só a especificação daquela fatia e poucas centenas de linhas.

No Orca, dividi o trabalho em tarefas pequenas rodando em paralelo, cada uma na sua cópia do repositório: uma cuidava dos formatos binários e da matemática, outra escrevia rotinas otimizadas para o processador, outra cuidava da leitura em disco e no S3, e outra montava os benchmarks em Docker. Ninguém pisava no git do outro, e um coordenador revisava as mudanças antes de juntar tudo na main. Deixar coleta e controle em Python simples, e usar modelos mais leves para tarefas menores, fez o limite mensal sobrar.

E aceitar código de IA não quer dizer fechar o olho. Travei tudo com checagens automáticas: o compilador proíbe certos atalhos perigosos em produção, verifica alinhamento de memória na marra e testes comparam cada rotina otimizada com uma versão simples passo a passo para garantir que o resultado matemático é idêntico.

## Tirando o grafo da jogada e separando os arquivos

Na prática, o desperdício de RAM vem de dois lugares: manter um grafo cheio de ponteiros na memória e deixar os vetores sem compressão por perto para reordenar os melhores resultados.

Resolvi jogar o grafo (HNSW) fora. Em vez de ficar pulando aleatoriamente pela memória atrás de vizinhos, o OspreyDB agrupa os vetores parecidos, organiza esses grupos para ficarem próximos no arquivo e faz uma varredura sequencial usando instruções rápidas do processador.

Também separei cada base de dados em dois arquivos. Um arquivo menor guarda só o índice comprimido, que fica na memória para busca rápida. O outro arquivo guarda os vetores completos (em meia precisão) e os textos/JSON em bloquinhos comprimidos no disco ou no S3. Como esses vetores completos ficam atrás de um cache com teto fixo ou são buscados só na hora do desempate, uma pesquisa não puxa gigabytes para a memória só para conferir os 20 ou 40 melhores resultados.

## Por que 4 bits em etapas em vez de 1 bit só

Comprimir cada número para apenas 1 bit parece ótimo na teoria, até bater num conjunto de dados mais chato. Nos testes que rodei, a compressão de 1 bit do Qdrant foi super bem no dataset do Cohere (96% de acerto), mas despencou para 11,7% no SIFT1M, porque os números lá são todos positivos e guardar só o sinal joga informação demais fora.

Para não cair nessa armadilha, o OspreyDB aplica uma transformação matemática rápida (Walsh-Hadamard) antes de comprimir, o que espalha melhor a informação entre as dimensões sem precisar de matrizes gigantes.

Depois disso, ele usa uma compressão de 4 bits (RaBitQ) organizada em camadas. Na primeira passada, a busca lê apenas o bit mais importante (um quarto dos dados) para descartar quase todo mundo bem rápido; depois olha os outros 3 bits só para uma lista curta de candidatos; e por fim busca apenas os 20 ou 40 vetores completos no disco ou no S3 para dar a nota exata. No dataset do Cohere com um milhão de vetores, o índice comprimido inteiro deu 513 MiB, e o arquivo de vetores no disco ficou em 1,38 GiB.

## Quando uma otimização bonita piorou a latência no S3

Medir tudo sem dó serve justamente para pegar ideia que parece genial no papel e quebra na rede.

A gente montou um planejador inteligente para juntar leituras próximas no S3 em uma única requisição grande, tentando economizar idas e vindas pela rede. Testando em um S3 local com latência artificial de uns 17 ms e sem cache nenhum, isso ajudou bastante na compressão de 1 bit.

No modo de 4 bits, saiu pela culatra. Como o filtro já deixava poucos candidatos, a etapa final só precisava ler umas 20 páginas pequenas espalhadas num arquivo de 1,38 GiB. Tentar juntar leituras distantes acabou estourando o limite inicial de pacotes da conexão e gerando retentativas. O tempo de resposta nos piores casos (P99) saltou de 22 ms para quase 62 ms.

Desligar essa junção inteligente para leituras muito espaçadas fez a latência voltar para cerca de 20 ms na mediana e 22 ms no P99, mantendo mais de 95% de precisão e consumindo em torno de 1 GiB de RAM sem cache local.

## Onde a conta de RAM parou

Para o comparativo ser justo, cada banco rodou sozinho num container num Ryzen 5 7600, reiniciando o container e limpando o cache do sistema operacional entre a indexação e as buscas. O teste mede busca estática somente leitura de um vetor por vez, sem escritas simultâneas nem filtros extras.

No SIFT1M (1 milhão de vetores de 128 dimensões) com 95% a 97% de precisão, o OspreyDB bateu 382,8 MiB de pico de RAM (entre 18 e 19 mil buscas por segundo, menos de meio milissegundo de latência), gastando de 3x a 6x menos memória que Qdrant e pgvector. No Cohere 1M (768 dimensões), fechou em cerca de 2 GiB de pico de RAM (entre 6,3 e 8,4 mil buscas por segundo), contra 2,9 GiB do Qdrant lendo do disco (que caiu para 623 buscas por segundo), 3,3 a 5,5 GiB do Qdrant em RAM e 8,5 GiB do pgvector. Um detalhe: o arquivo de teste do Cohere só tem 1.000 perguntas ao todo, então a margem de erro da precisão se sobrepõe um pouco entre os bancos.

O código e os scripts de benchmark estão no GitHub sob licença Apache-2.0 (`ospreydb/ospreydb` e `ospreydb/benchmarks`).

## Um aviso grande sobre vibecoding e produção

> Sim, a arquitetura do OspreyDB faz sentido no papel e nos benchmarks, mas não existe cenário nenhum em que eu colocaria isso em um sistema de produção. Eu posso usar para indexar minha biblioteca pessoal de arquivos aqui em casa e, como o código é aberto, quem quiser pode brincar com ele do mesmo jeito. Mas eu não tenho a menor pretensão de transformar o OspreyDB em produto ou projeto comercial, até porque eu mesmo não saberia dar suporte direito para uma base de código vibecodada.
>
> Voltando àquela minha aposta lá do começo: para projeto de fim de semana, experimento e ferramenta pessoal, vibecoding funciona muito bem. Para produção de verdade, ainda não rola.

</div>

<div class="en-only">

If you have ever tried self-hosting a million 768-dimensional embeddings, you know how fast RAM vanishes.

Just the raw numbers already take almost 3 GiB. On top of that, most vector databases keep a giant graph in memory to hop between neighbors, store metadata, and keep uncompressed vectors nearby to rescore top results. When I ran a 1M vector benchmark (Cohere dataset) inside isolated containers, pgvector peaked at 8.5 GiB of RAM. Qdrant landed between 4.6 and 5.5 GiB, and in-process FAISS hit around 7 GiB.

I wanted to see how low I could push that RAM footprint in Rust without ruining search quality or speed. At the same time, I wanted to test a hunch: if coding with LLMs is going to be part of daily work, how do you actually build a whole project with them without it turning into a mess?

The result is [OspreyDB](https://github.com/ospreydb/ospreydb), built on two $20/month AI subscriptions (zero pay-per-token API bills) by keeping both idea selection and coding strictly isolated.

## Burying 104 ideas before writing any Rust

OspreyDB came out of another repo I built called breakthrough-hunter. I made it because I tend to get excited about random side projects nobody asked for and burn weeks building them.

The rule there is spending zero money on external AI APIs inside the scraping scripts. Simple Python scripts pull recent ArXiv papers, Hacker News complaints, and GitHub issues into a single queue.

From there, the queue runs in waves of four ideas at a time. First, 4 agents run in parallel, each locked inside its own folder so one agent's tangent doesn't pollute another's context. Each one cross-references the paper or problem with real market complaints, checks solo feasibility, and writes a short dossier.

Once all four finish, a single adversarial judge called Argon takes over. I even added a hard check in Python so the judge can't evaluate any raw idea before it goes through the four researchers. Whoever does the research shouldn't be the same process trying to kill it.

Argon puts each dossier through 9 strict kill filters: two-sided marketplaces that need users on day one, slow enterprise sales cycles, nice-to-have "vitamins" with no real pain, fragile single-API wrappers, disguised consulting, scopes too big for one person, and what I called "cosmetic science" (slapping paper jargon onto something a simple text search could solve). Fail a single filter and the idea goes straight to a graveyard file with its cause of death.

Out of 114 ideas fed into that machine, 104 were buried and only 10 survived.

The #1 survivor (89/100) combined compact quantization and on-demand S3 reads to avoid RAM-heavy graphs. At #5 (86/100) was a fast CPU reranker that skips GPUs. Combining the two became OspreyDB. Funny enough, right after that batch I switched the idea hunter to look for simpler SaaS tools because databases are brutal to build, and then stubbornly went ahead and built idea #1 anyway.

## Vibecoding with Orca, parallel branches, and $40/month

If you open one giant chat and tell an LLM to "write a Rust vector database," everything falls apart around 2,000 lines. Context fills up, the model forgets yesterday's file layout, and fixing one module quietly breaks another.

To stay inside two $20/month subscriptions, I brought the same isolation mindset into coding using Orca and parallel git worktrees.

Before writing code, I froze the contracts and boundaries between modules. The core math crate, for instance, is banned from touching disk or network. With tight boundaries, no agent ever needed the whole repo in context, just the spec for its slice and a few hundred lines of code.

In Orca, I split work into small tasks running simultaneously in separate copies of the repo: one handled binary formats and math, another wrote CPU-optimized routines, another handled disk and S3 reads, and another built the Docker benchmark suite. Nobody stepped on anyone else's git state, and a coordinator reviewed diffs before merging to main. Leaving scraping and queue locks to plain Python and using lighter models for smaller tasks left plenty of headroom inside both $20/month caps.

Accepting AI code doesn't mean turning a blind eye. Everything is boxed in by automatic checks: the compiler forbids risky shortcuts in production, enforces memory alignment at build time, and differential tests force every optimized CPU routine to match a plain step-by-step scalar version.

## Ditching the graph and splitting the files

In practice, RAM bloat comes from two habits: keeping a pointer-heavy graph in memory and keeping uncompressed vectors around to rescore top results.

So I threw the graph (HNSW) out. Instead of jumping randomly across memory chasing neighbors, OspreyDB groups similar vectors, orders those groups so nearby ones sit close together in the file, and scans compressed codes sequentially with fast CPU instructions.

I also split each dataset into two files. A smaller file holds only the compressed index, which stays in memory for fast scans. The other file stores exact half-precision vectors and JSON payloads inside compressed blocks on disk or S3. Because exact vectors sit behind a capped cache or get fetched only at the end, queries don't drag gigabytes into memory just to rescore 20 or 40 candidates.

## Why progressive 4-bit instead of 1-bit quantization

Shrinking every number down to 1 bit looks great on paper until you hit a picky dataset. In my tests, Qdrant's 1-bit quantization hit 96% recall on Cohere, then crashed to 11.7% on SIFT1M because SIFT vectors are all positive and keeping only the sign throws away too much direction.

To avoid that trap, OspreyDB runs a fast mathematical transform (Walsh-Hadamard) before quantizing, spreading variance across dimensions without needing giant rotation matrices.

Then it uses 4-bit compression (RaBitQ) arranged in layers. The first pass reads only the most important bit (a quarter of the data) to drop most candidates quickly; the second pass checks the remaining 3 bits on a short list; and the final stage pulls just 20 or 40 exact vectors from disk or S3 for the final score. On Cohere 1M, the whole compressed index takes 513 MiB, and the vector file on disk takes 1.38 GiB.

## When a clever S3 optimization backfired

Measuring everything skeptically is mostly about catching ideas that look great on paper and break on the network.

We built a smart planner to merge nearby S3 reads into a single larger request to save network round-trips. Tested against a local S3 server with ~17 ms of artificial latency and zero local cache, it worked nicely for 1-bit quantization.

On 4-bit progressive search, it backfired. Because the filter already left a tiny shortlist, the final step only needed around 20 small pages scattered across a 1.38 GiB file. Trying to bridge wide gaps between them overshot TCP's initial packet window and triggered retries. Tail latency (P99) jumped from 22 ms to nearly 62 ms.

Turning that merging off for sparse 4-bit reads brought latency back down to ~20 ms median and 22 ms P99 at over 95% recall, holding process memory around 1 GiB with zero local cache.

## Where the RAM numbers landed

To keep things fair, every engine ran solo in a container on a Ryzen 5 7600, restarting containers and flushing the OS cache between indexing and queries. This tests static, read-only single-vector search without concurrent writes or metadata filters.

On SIFT1M (1M vectors, 128 dimensions) at 95–97% recall, OspreyDB peaked at 382.8 MiB of RAM (18–19k queries per second, under half a millisecond median latency), using 3x to 6x less memory than Qdrant and pgvector. On Cohere 1M (768 dimensions), it peaked around 2 GiB of RAM (6.3–8.4k QPS), versus 2.9 GiB for Qdrant on disk (which dropped to 623 QPS), 3.3–5.5 GiB for Qdrant in RAM, and 8.5 GiB for pgvector. Worth noting: the Cohere test file only has 1,000 queries total, so recall confidence intervals overlap slightly across engines.

Both the database and the benchmark suite are Apache-2.0 on GitHub (`ospreydb/ospreydb` and `ospreydb/benchmarks`).

## A big disclaimer on vibecoding and production

> Yes, OspreyDB makes sense technically on paper and in the benchmarks, but there is no world where it should be used in a production system. I can run it at home to index my personal file library, and since it is open source, anyone else can tinker with it the same way. Still, I have zero plans to turn OspreyDB into a for-profit project or product, because I honestly wouldn't even know how to properly support a vibecoded codebase.
>
> Wrapping up that personal bet from the intro: for a hobby, an experiment, or a personal tool, vibecoding works great. For real production, no chance.

</div>

<div class="es-only">

Quien ha intentado alojar por su cuenta un millón de embeddings de 768 dimensiones sabe lo rápido que se va la RAM.

Solo los números crudos ya ocupan casi 3 GiB. Encima de eso, la mayoría de las bases vectoriales mantienen un grafo gigante en memoria para saltar entre vecinos, guardan metadatos y necesitan los vectores sin compresión cerca para recalcular el resultado final. Cuando medí un millón de vectores (dataset Cohere) en contenedores aislados, pgvector llegó a 8,5 GiB de pico de RAM. Qdrant quedó entre 4,6 y 5,5 GiB, e incluso FAISS en proceso llegó a unos 7 GiB.

Quería ver hasta dónde podía bajar ese consumo en Rust sin arruinar la calidad ni la velocidad de búsqueda, y de paso comprobar en la práctica si se puede armar un proyecto entero con LLMs sin que se vuelva un caos. El resultado fue [OspreyDB](https://github.com/ospreydb/ospreydb), hecho con dos suscripciones de US$ 20/mes (cero facturas por token), separando tanto la búsqueda de la idea como el código en etapas aisladas.

## Enterrando 104 ideas antes de escribir Rust

OspreyDB salió de otro proyecto que armé, breakthrough-hunter, pensado para evitar entusiasmarme con proyectos aleatorios que nadie pidió y perder semanas en ellos.

La regla ahí es cero gasto en APIs externas de IA dentro de los scripts de recolección. Scripts simples en Python traen papers recientes de ArXiv, quejas de Hacker News e issues de GitHub a una cola única.

Después la cola corre en tandas de cuatro ideas: 4 agentes en paralelo aislados en carpetas distintas para no contaminarse el contexto, y luego un único juez adversarial llamado Argon (con una traba para que no pueda evaluar ninguna idea cruda antes de pasar por los investigadores). Argon pasa cada dossier por 9 filtros duros de eliminación. De 114 ideas, 104 fueron enterradas y solo 10 sobrevivieron. La #1 (89/100) combinaba cuantización compacta y lecturas bajo demanda en S3; la #5 (86/100) era un reranker rápido en CPU sin GPU. Juntar las dos se convirtió en OspreyDB.

## Vibecoding con Orca, branches en paralelo y US$ 40/mes

Pedirle a un solo chat que "escriba una base vectorial en Rust" se rompe alrededor de las 2.000 líneas. Para mantenerme dentro de dos suscripciones de US$ 20/mes, congelé primero las fronteras entre módulos y usé Orca con varias worktrees de git en paralelo: una para formatos binarios y matemática, otra para rutinas optimizadas de CPU, otra para disco y S3, y otra para benchmarks en Docker, sin pisarse en git.

Aceptar código de IA no significa cerrar los ojos: el compilador prohíbe atajos riesgosos en producción, verifica el alineamiento de memoria al compilar y tests comparan cada rutina optimizada contra una versión simple paso a paso.

## Quitar el grafo, usar 4 bits en etapas y medir de verdad

OspreyDB elimina el grafo (HNSW) y separa la base en dos archivos: uno más chico con el índice comprimido en memoria y otro con los vectores exactos en media precisión y JSON comprimidos en disco o S3, detrás de un caché acotado. Antes de cuantizar aplica una transformación rápida (Walsh-Hadamard) para que datasets no negativos como SIFT1M no colapsen (donde el 1-bit de Qdrant cayó al 11,7% de acierto). Luego usa RaBitQ de 4 bits por capas: lee primero el bit más importante, filtra una lista corta con los otros 3 y solo trae 20 o 40 vectores completos del disco o S3. En Cohere 1M, el índice ocupa 513 MiB y el archivo de vectores 1,38 GiB.

Medir todo también mostró una optimización que salió mal: agrupar lecturas cercanas en S3 ayudaba en 1 bit, pero en 4 bits progresivos solo hacían falta ~20 páginas dispersas; intentar unirlas disparó reintentos TCP y subió la latencia P99 de 22 ms a casi 62 ms. Desactivarlo en lecturas dispersas devolvió ~20 ms P50 / 22 ms P99 con más del 95% de acierto y ~1 GiB de RAM sin caché local.

En contenedores aislados (Ryzen 5 7600, limpiando el caché del sistema entre indexación y consultas, búsqueda estática de solo lectura), OspreyDB alcanzó 382,8 MiB de RAM en SIFT1M (18–19k QPS) y ~2 GiB en Cohere 1M (6,3–8,4k QPS), frente a 2,9–8,5 GiB en Qdrant y pgvector. El código y los benchmarks están bajo Apache-2.0 en `ospreydb/ospreydb` y `ospreydb/benchmarks`.

## Un aviso importante sobre vibecoding y producción

> Sí, la arquitectura de OspreyDB tiene sentido técnico y los benchmarks acompañan, pero no hay ningún mundo en el que esto deba usarse en producción. Puedo usarlo para indexar mi biblioteca personal de archivos y, al ser open source, cualquiera puede hacer lo mismo. Pero no pienso convertir OspreyDB en un proyecto con fines de lucro, básicamente porque ni yo mismo sabría dar soporte serio a un código vibecodeado.
>
> Cerrando aquella apuesta del principio: para hobby y herramientas personales, vibecoding va bien. Para producción, ni hablar.

</div>

<div class="fr-only">

Quiconque a déjà essayé d'auto-héberger un million d'embeddings de 768 dimensions sait à quelle vitesse la RAM disparaît.

Les nombres bruts prennent déjà près de 3 Gio. Là-dessus, la plupart des bases vectorielles gardent un gros graphe en mémoire, des métadonnées et des vecteurs non compressés pour le calcul final. Sur un million de vecteurs (Cohere) en conteneurs isolés, pgvector monte à 8,5 Gio de pic RAM, Qdrant entre 4,6 et 5,5 Gio, et FAISS en processus approche les 7 Gio.

Je voulais voir jusqu'où réduire cette empreinte en Rust sans casser la qualité ni la vitesse, tout en vérifiant si l'on peut mener un vrai projet avec des LLM sans que ça parte dans tous les sens. Le résultat est [OspreyDB](https://github.com/ospreydb/ospreydb), construit avec deux abonnements à 20 $/mois (zéro facture API au token), en isolant le choix de l'idée comme le code.

## Enterrer 104 idées avant d'écrire du Rust

OspreyDB vient d'un autre outil que j'ai monté, breakthrough-hunter, pour éviter de perdre des semaines sur des projets dont personne ne veut. Des scripts Python simples récupèrent des papiers ArXiv, des discussions Hacker News et des issues GitHub dans une file unique, sans appel payant à une API d'IA.

La file tourne par vagues de quatre : 4 agents en parallèle isolés dans des dossiers séparés, puis un juge adversarial unique appelé Argon (avec un verrou l'empêchant d'évaluer une idée brute avant le passage des chercheurs). Via 9 filtres stricts, sur 114 idées, 104 ont été enterrées et 10 ont survécu. Le #1 (89/100) combinait quantification compacte et lecture S3 à la demande ; le #5 (86/100) était un reranker rapide sur CPU sans GPU. Fusionner les deux a donné OspreyDB.

## Vibecoder avec Orca, des branches parallèles et 40 $/mois

Demander à un seul chat d'écrire une base vectorielle en Rust déraille vite. J'ai figé les frontières entre modules (le cœur mathématique n'a pas le droit de toucher au disque ou au réseau) et découpé les tâches dans Orca avec des worktrees git en parallèle sur les formats binaires, les routines CPU, le stockage disque/S3 et les benchmarks Docker, sans conflits git.

Côté sécurité : le compilateur bloque les raccourcis risqués en production, vérifie l'alignement mémoire à la compilation, et des tests comparent chaque routine optimisée à une version simple étape par étape.

## Supprimer le graphe, passer au 4-bit en couches et mesurer honnêtement

OspreyDB abandonne le graphe (HNSW) et sépare l'index compressé (chaud en mémoire) des vecteurs exacts en demi-précision et du JSON (compressés sur disque ou S3 derrière un cache borné). Une transformée rapide (Walsh-Hadamard) évite l'effondrement sur des données non négatives comme SIFT1M (où le 1-bit de Qdrant chute à 11,7 % de rappel). Ensuite, le RaBitQ 4-bit en couches lit d'abord le bit principal, affine une courte liste avec les 3 autres bits et ne charge que 20 à 40 vecteurs exacts (`513 Mio` pour l'index et `1,38 Gio` sur disque pour Cohere 1M).

Nos mesures sur MinIO avec ~17 ms de latence ont aussi montré un piège : fusionner les lectures S3 voisines aide en 1-bit, mais sur les ~20 pages éparses du 4-bit ça dépassait la fenêtre TCP initiale et faisait bondir le P99 de 22 ms à près de 62 ms. Le désactiver a ramené ~20 ms P50 / 22 ms P99 à plus de 95 % de rappel (~1 Gio de RAM sans cache local).

En conteneurs isolés (Ryzen 5 7600, cache système vidé entre indexation et requêtes, recherche statique en lecture seule), OspreyDB plafonne à 382,8 Mio sur SIFT1M (18–19k QPS) et ~2 Gio sur Cohere 1M (6,3–8,4k QPS), contre 2,9 à 8,5 Gio pour Qdrant et pgvector. Le tout est sous licence Apache-2.0 sur GitHub (`ospreydb/ospreydb` et `ospreydb/benchmarks`).

## Un gros avertissement sur le vibecoding et la production

> Oui, OspreyDB tient la route techniquement et dans les benchmarks, mais il n'existe aucun monde où il devrait tourner en production. Je peux l'utiliser pour indexer ma bibliothèque personnelle de fichiers, et comme c'est open source, n'importe qui peut faire pareil. En revanche, je n'ai aucune intention d'en faire un projet commercial, tout simplement parce que je ne saurais même pas maintenir et supporter sérieusement une base de code vibecodée.
>
> Pour boucler le pari du début : pour un hobby ou un outil perso, le vibecoding passe très bien. Pour la vraie production, c'est non.

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
