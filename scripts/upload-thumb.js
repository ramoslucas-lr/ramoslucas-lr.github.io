import fs from 'fs';
import sharp from 'sharp';
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

dotenv.config();

const url = "https://image.api.playstation.com/vulcan/img/rnd/202011/1215/WyHa1BM3ISDVqYSEUMB9VZJs.png";
const thumbKey = "thumbs/games/red-dead-redemption-2.webp";

async function upload() {
  console.log("Downloading...");
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  
  console.log("Resizing...");
  const webpBuffer = await sharp(buffer)
    .resize({ width: 1200, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
    
  const s3Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  
  console.log("Uploading...");
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: thumbKey,
    Body: webpBuffer,
    ContentType: "image/webp",
  }));
  
  console.log("Done!");
}
upload();
