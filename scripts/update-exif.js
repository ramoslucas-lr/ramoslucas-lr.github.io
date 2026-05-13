import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import exifr from 'exifr';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONTENT_DIR = path.join(process.cwd(), 'src', 'content', 'photography');
const PUBLIC_DIR = path.join(process.cwd(), 'public');

async function processPhotos() {
  console.log('Scanning photography essays...');
  if (!fs.existsSync(CONTENT_DIR)) {
    console.log('No photography directory found.');
    return;
  }
  
  const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.md') || f.endsWith('.mdx'));

  for (const file of files) {
    const filePath = path.join(CONTENT_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = matter(content);

    if (!parsed.data.gallery || !Array.isArray(parsed.data.gallery)) {
      continue;
    }

    console.log(`Processing ${file}...`);
    let modified = false;

    for (let i = 0; i < parsed.data.gallery.length; i++) {
      const img = parsed.data.gallery[i];
      if (!img.src) continue;

      let sourceForExifr = img.src;
      
      if (!img.src.startsWith('http://') && !img.src.startsWith('https://')) {
        sourceForExifr = path.join(PUBLIC_DIR, img.src);
        if (!fs.existsSync(sourceForExifr)) {
          console.warn(`  Image not found locally: ${img.src}`);
          continue;
        }
      }

      try {
        const exif = await exifr.parse(sourceForExifr, {
          tiff: true,
          exif: true,
        });

        if (exif) {
          if (exif.Model && img.camera !== exif.Model) {
            img.camera = exif.Model;
            modified = true;
          }
          if (exif.LensModel && img.lens !== exif.LensModel) {
            img.lens = exif.LensModel;
            modified = true;
          }
          if (exif.FNumber) {
            const aperture = `f/${exif.FNumber.toFixed(1)}`;
            if (img.aperture !== aperture) {
              img.aperture = aperture;
              modified = true;
            }
          }
          if (exif.ISO && img.iso !== exif.ISO) {
            img.iso = exif.ISO;
            modified = true;
          }
          if (exif.ExposureTime) {
            const shutter = exif.ExposureTime >= 1 ? `${exif.ExposureTime}s` : `1/${Math.round(1 / exif.ExposureTime)}s`;
            if (img.shutterSpeed !== shutter) {
              img.shutterSpeed = shutter;
              modified = true;
            }
          }
          console.log(`  Read EXIF for ${img.src}`);
        }
      } catch (err) {
        console.error(`  Error parsing EXIF for ${img.src}:`, err.message);
      }
    }

    if (modified) {
      const updatedContent = matter.stringify(parsed.content, parsed.data);
      fs.writeFileSync(filePath, updatedContent, 'utf8');
      console.log(`Saved changes to ${file}`);
    } else {
      console.log(`No updates needed for ${file}`);
    }
  }
  
  console.log('Finished updating EXIF data!');
}

processPhotos().catch(console.error);
