import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import matter from 'gray-matter';
import exifr from 'exifr';
import sharp from 'sharp';
import dotenv from 'dotenv';
import { S3Client, ListObjectsV2Command, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

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

// Configurações de otimização do thumb
const THUMB_MAX_WIDTH = 1200;    // Largura máxima do thumbnail
const THUMB_QUALITY = 80;        // Qualidade WebP (0-100)
const THUMB_PREFIX = 'thumbs';   // Prefixo/pasta no R2 para os thumbnails

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

/**
 * Baixa uma imagem a partir de uma URL e retorna o Buffer.
 */
async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ao baixar ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Gera a chave (path) do thumbnail no R2 a partir da chave original.
 * Ex: "viagem-serra/foto.jpg" -> "thumbs/viagem-serra/foto.webp"
 */
function getThumbKey(originalKey) {
  const parsed = path.parse(originalKey);
  return `${THUMB_PREFIX}/${parsed.dir}/${parsed.name}.webp`;
}

/**
 * Verifica se um objeto já existe no R2.
 */
async function objectExists(s3Client, bucketName, key) {
  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: bucketName,
      Key: key,
    }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

/**
 * Converte uma imagem (Buffer) para WebP otimizado com resolução reduzida.
 */
async function createOptimizedWebp(imageBuffer) {
  return sharp(imageBuffer)
    .resize({ width: THUMB_MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();
}

/**
 * Faz upload de um Buffer para o R2.
 */
async function uploadToR2(s3Client, bucketName, key, buffer, contentType = 'image/webp') {
  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
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

    // --- 1. Lista arquivos no R2 (originais, ignora thumbs/) ---
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
        // Filtra apenas imagens válidas E ignora a pasta thumbs/
        return IMAGE_EXTENSIONS.includes(ext) && !obj.Key.startsWith(`${THUMB_PREFIX}/`);
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

    // --- 3. Extrai EXIF + gera thumb otimizado para cada imagem ---
    const imageFiles = r2Contents.map(obj => obj.Key).sort();
    const gallery = [];

    for (const key of imageFiles) {
      const r2Url = `${baseUrl.replace(/\/$/, '')}/${key}`;
      const thumbKey = getThumbKey(key);
      const thumbUrl = `${baseUrl.replace(/\/$/, '')}/${thumbKey}`;
      const fileName = path.basename(key);

      console.log(`  🔍 Processando: ${fileName}`);

      try {
        // 3a. Extrai EXIF via Range Request (só baixa o header do arquivo)
        console.log(`    📋 Extraindo metadados EXIF...`);
        const exif = await exifr.parse(r2Url, { tiff: true, exif: true });
        const photoData = { src: r2Url, thumb: thumbUrl };

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

        // 3b. Verifica se o thumb já existe no R2
        const thumbExists = await objectExists(s3Client, bucketName, thumbKey);

        if (thumbExists) {
          console.log(`    ✅ Thumb já existe no R2: ${thumbKey}`);
        } else {
          // 3c. Baixa a imagem original completa
          console.log(`    ⬇️  Baixando imagem original para gerar thumb...`);
          const imageBuffer = await downloadImage(r2Url);

          // 3d. Gera o WebP otimizado
          console.log(`    🖼️  Gerando WebP otimizado (max ${THUMB_MAX_WIDTH}px, qualidade ${THUMB_QUALITY})...`);
          const webpBuffer = await createOptimizedWebp(imageBuffer);

          const originalSize = (imageBuffer.length / 1024).toFixed(0);
          const thumbSize = (webpBuffer.length / 1024).toFixed(0);
          const reduction = ((1 - webpBuffer.length / imageBuffer.length) * 100).toFixed(1);
          console.log(`    📊 ${originalSize}KB → ${thumbSize}KB (${reduction}% menor)`);

          // 3e. Faz upload do thumb para o R2
          console.log(`    ⬆️  Enviando thumb para R2: ${thumbKey}`);
          await uploadToR2(s3Client, bucketName, thumbKey, webpBuffer);
          console.log(`    ✅ Thumb enviado com sucesso!`);
        }

        gallery.push(photoData);
      } catch (err) {
        console.warn(`  ⚠️ Erro ao processar ${fileName}: ${err.message}`);
        // Fallback: usa a original como thumb também
        gallery.push({ src: r2Url, thumb: r2Url });
      }
    }

    // --- 4. Monta o frontmatter ---
    const frontmatter = {
      title: title,
      titleEn: title,
      titleFr: title,
      cover: gallery[0].src,
      coverThumb: gallery[0].thumb,
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
      // Preserva títulos traduzidos se já existirem
      if (existingContent.data.titleEn) frontmatter.titleEn = existingContent.data.titleEn;
      if (existingContent.data.titleFr) frontmatter.titleFr = existingContent.data.titleFr;
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
