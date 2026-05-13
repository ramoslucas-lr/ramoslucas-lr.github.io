import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import matter from 'gray-matter';
import exifr from 'exifr';
import dotenv from 'dotenv';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

// Carrega as variáveis de ambiente do .env
dotenv.config();

// ==========================================
// CONFIGURAÇÃO
// ==========================================
const CONTENT_DIR = path.join(process.cwd(), 'src', 'content', 'photography');
const CONFIG_FILE = path.join(process.cwd(), 'essays.json');

// Arquivo de cache: guarda o hash do conjunto de arquivos de cada ensaio
// para evitar baixar EXIFs de álbuns que não mudaram
const CACHE_FILE = path.join(process.cwd(), '.essays-cache.json');

// Extensões de imagem suportadas
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];

// ==========================================
// HELPERS
// ==========================================

/**
 * Gera um hash MD5 de uma lista de chaves de arquivos do R2.
 * Inclui o nome e o tamanho (ETag) para detectar alterações.
 */
function hashFileList(contents) {
  const signature = contents
    .map(obj => `${obj.Key}:${obj.ETag}:${obj.Size}`)
    .sort()
    .join('|');
  return crypto.createHash('md5').update(signature).digest('hex');
}

/**
 * Converte uma data (string "YYYY-MM-DD") para ISO no fuso UTC-3,
 * garantindo que o dia exibido no site seja o dia correto para quem está em BRT.
 */
function toUTCMinus3ISOString(dateStr) {
  return `${dateStr}T00:00:00.000-03:00`;
}

// ==========================================
// SCRIPT PRINCIPAL
// ==========================================

async function syncEssays() {
  console.log('🚀 Iniciando sincronização Cloud-First de ensaios (S3/R2)...');

  // Verifica credenciais do R2
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT;
  const bucketName = process.env.R2_BUCKET_NAME;

  if (!accessKeyId || !secretAccessKey || !endpoint || !bucketName) {
    console.error('❌ Erro: Credenciais do R2 não encontradas no arquivo .env.');
    console.error('   Copie o arquivo .env.example para .env e preencha suas chaves.');
    process.exit(1);
  }

  // Configura o Cliente S3 apontando para o R2
  const s3Client = new S3Client({
    region: 'auto',
    endpoint: endpoint,
    credentials: {
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey,
    },
  });

  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`❌ Erro: Arquivo ${CONFIG_FILE} não encontrado.`);
    process.exit(1);
  }

  // Carrega o cache de hashes dos álbuns anteriores
  let cache = {};
  if (fs.existsSync(CACHE_FILE)) {
    try {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch {
      cache = {};
    }
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const baseUrl = config.r2BaseUrl;
  let cacheUpdated = false;

  for (const essay of config.essays) {
    const { id, title, date, folder } = essay;
    const targetMdFile = path.join(CONTENT_DIR, `${id}.md`);

    console.log(`\n📸 Processando ensaio: ${title} (${id})`);
    console.log(`  🌐 Listando arquivos na pasta R2: ${folder}/`);

    // --- 1. Lista arquivos no R2 ---
    let r2Contents = [];
    try {
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: folder.endsWith('/') ? folder : `${folder}/`,
      });

      const response = await s3Client.send(command);

      if (!response.Contents || response.Contents.length === 0) {
        console.warn(`  ⚠️ Nenhuma imagem encontrada na pasta R2: ${folder}/`);
        continue;
      }

      r2Contents = response.Contents.filter(obj => {
        const ext = path.extname(obj.Key).toLowerCase();
        return IMAGE_EXTENSIONS.includes(ext);
      });

    } catch (err) {
      console.error(`  ❌ Erro ao listar arquivos no R2:`, err.message);
      continue;
    }

    if (r2Contents.length === 0) {
      console.warn(`  ⚠️ Nenhuma imagem válida (.jpg, .png, etc) encontrada.`);
      continue;
    }

    // --- 2. Verifica se o álbum mudou comparando o hash da listagem ---
    const currentHash = hashFileList(r2Contents);
    const cachedHash = cache[id];
    const albumChanged = currentHash !== cachedHash;
    const mdExists = fs.existsSync(targetMdFile);

    if (!albumChanged && mdExists) {
      console.log(`  ✅ Sem mudanças detectadas no R2. Pulando download de EXIF.`);
      continue;
    }

    if (albumChanged) {
      console.log(`  🔄 Mudança detectada no álbum (${r2Contents.length} arquivos). Atualizando...`);
    } else {
      console.log(`  ✨ Arquivo .md não existe ainda. Gerando...`);
    }

    // --- 3. Extrai EXIF de cada imagem via URL pública ---
    const imageFiles = r2Contents.map(obj => obj.Key).sort();
    const gallery = [];

    for (const key of imageFiles) {
      const r2Url = `${baseUrl.replace(/\/$/, '')}/${key}`;
      console.log(`  🔍 Extraindo metadados EXIF: ${path.basename(key)}`);

      try {
        // exifr faz Range Requests HTTP — baixa só o início do arquivo onde fica o EXIF
        const exif = await exifr.parse(r2Url, { tiff: true, exif: true });
        const photoData = { src: r2Url };

        if (exif) {
          if (exif.Model) photoData.camera = exif.Model;
          if (exif.LensModel) photoData.lens = exif.LensModel;
          if (exif.FNumber) photoData.aperture = `f/${exif.FNumber.toFixed(1)}`;
          if (exif.ISO) photoData.iso = exif.ISO;
          if (exif.ExposureTime) {
            photoData.shutterSpeed = exif.ExposureTime >= 1
              ? `${exif.ExposureTime}s`
              : `1/${Math.round(1 / exif.ExposureTime)}s`;
          }
        }

        gallery.push(photoData);
      } catch (err) {
        console.warn(`  ⚠️ Sem EXIF para ${path.basename(key)}: ${err.message}`);
        gallery.push({ src: r2Url });
      }
    }

    // --- 4. Monta o frontmatter ---
    const frontmatter = {
      title: title,
      titleEn: title,
      titleFr: title,
      cover: gallery[0].src,
      gallery: gallery,
    };

    // Data em UTC-3 para exibir o dia correto no site
    if (date) {
      frontmatter.date = toUTCMinus3ISOString(date);
    }

    // --- 5. Preserva o corpo do Markdown se o arquivo já existir ---
    let existingBody = '\n<div class="pt-only">\nDescrição do ensaio aqui.\n</div>';
    if (mdExists) {
      const existingContent = matter(fs.readFileSync(targetMdFile, 'utf8'));
      existingBody = existingContent.content;
      console.log(`  ♻️ Atualizando frontmatter de ${id}.md preservando o texto.`);
    } else {
      console.log(`  ✨ Criando novo arquivo ${id}.md`);
    }

    const newContent = matter.stringify(existingBody, frontmatter);
    fs.writeFileSync(targetMdFile, newContent);

    // --- 6. Salva o novo hash no cache ---
    cache[id] = currentHash;
    cacheUpdated = true;
    console.log(`  ✅ Ensaio concluído!`);
  }

  // Persiste o cache atualizado
  if (cacheUpdated) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log('\n💾 Cache de hashes atualizado.');
  }

  console.log('\n✨ Sincronização concluída!');
}

syncEssays().catch(err => {
  console.error('💥 Erro fatal no script:', err);
});
