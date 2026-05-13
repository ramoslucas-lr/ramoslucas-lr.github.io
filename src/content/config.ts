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
    date: z.coerce.date().optional(),
    cover: z.string(),
    gallery: z.array(
      z.object({
        src: z.string(),
        camera: z.string().optional(),
        lens: z.string().optional(),
        aperture: z.string().optional(),
        iso: z.number().optional(),
        shutterSpeed: z.string().optional(),
        caption: z.string().optional(),
        captionEn: z.string().optional(),
        captionFr: z.string().optional()
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
    course: z.string(),
    courseEn: z.string().optional(),
    courseFr: z.string().optional(),
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
    game: z.string(),
    year: z.number(),
    rating: z.number().min(1).max(10),
    cover: z.string().optional(),
  }),
});

export const collections = {
  'homepage': homepageCollection,
  'photography': photographyCollection,
  'data-engineering': dataEngineeringCollection,
  'academic': academicCollection,
  'dice-awards': diceAwardsCollection,
};
