import { z, defineCollection } from 'astro:content';

const homepageCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
  }),
});

const photographyCollection = defineCollection({
  type: 'content',
  schema: ({ image }) => z.object({
    title: z.string(),
    titleEn: z.string().optional(),
    titleFr: z.string().optional(),
    titleEs: z.string().optional(),
    titleJa: z.string().optional(),
    titleZh: z.string().optional(),
    titleDe: z.string().optional(),
    titleRu: z.string().optional(),
    date: z.coerce.date().optional(),
    cover: z.string(),
    coverThumb: z.string().optional(),
    gallery: z.array(
      z.object({
        src: z.string(),
        thumb: z.string().optional(),
        camera: z.string().optional(),
        lens: z.string().optional(),
        aperture: z.string().optional(),
        iso: z.number().optional(),
        shutterSpeed: z.string().optional(),
        caption: z.string().optional(),
        captionEn: z.string().optional(),
        captionFr: z.string().optional(),
        captionEs: z.string().optional(),
        captionJa: z.string().optional(),
        captionZh: z.string().optional(),
        captionDe: z.string().optional(),
        captionRu: z.string().optional()
      })
    ).optional(),
  }),
});

const dataEngineeringCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    titleEn: z.string().optional(),
    titleFr: z.string().optional(),
    titleEs: z.string().optional(),
    titleJa: z.string().optional(),
    titleZh: z.string().optional(),
    titleDe: z.string().optional(),
    titleRu: z.string().optional(),
    date: z.date(),
    technologies: z.array(z.string()),
    repoUrl: z.string().url().optional(),
  }),
});

const academicCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    titleEn: z.string().optional(),
    titleFr: z.string().optional(),
    titleEs: z.string().optional(),
    titleJa: z.string().optional(),
    titleZh: z.string().optional(),
    titleDe: z.string().optional(),
    titleRu: z.string().optional(),
    course: z.string(),
    courseEn: z.string().optional(),
    courseFr: z.string().optional(),
    courseEs: z.string().optional(),
    courseJa: z.string().optional(),
    courseZh: z.string().optional(),
    courseDe: z.string().optional(),
    courseRu: z.string().optional(),
    semester: z.string(),
    grade: z.string().optional(),
  }),
});

const diceAwardsCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    titleEn: z.string().optional(),
    titleFr: z.string().optional(),
    titleEs: z.string().optional(),
    titleJa: z.string().optional(),
    titleZh: z.string().optional(),
    titleDe: z.string().optional(),
    titleRu: z.string().optional(),
    game: z.string(),
    year: z.number(),
    rating: z.number().min(1).max(10),
    cover: z.string().optional(),
  }),
});

const blogCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    titleEn: z.string().optional(),
    titleFr: z.string().optional(),
    titleEs: z.string().optional(),
    titleJa: z.string().optional(),
    titleZh: z.string().optional(),
    titleDe: z.string().optional(),
    titleRu: z.string().optional(),
    date: z.date(),
    description: z.string().optional(),
    descriptionEn: z.string().optional(),
    descriptionFr: z.string().optional(),
    descriptionEs: z.string().optional(),
    descriptionJa: z.string().optional(),
    descriptionZh: z.string().optional(),
    descriptionDe: z.string().optional(),
    descriptionRu: z.string().optional(),
    cover: z.string().optional(),
  }),
});

export const collections = {
  'homepage': homepageCollection,
  'photography': photographyCollection,
  'data-engineering': dataEngineeringCollection,
  'academic': academicCollection,
  'dice-awards': diceAwardsCollection,
  'blog': blogCollection,
};
