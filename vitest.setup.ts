import { config } from 'dotenv';
import { testEnv } from './vitest.test-env';

config();

// Los tests vacían la base y encolan en Redis: jamás sobre los datos de
// desarrollo. Sin esto, cada `pnpm test` borraba el negocio dado de alta con
// `dev:provision` y el worker de desarrollo se comía los jobs de los tests.
Object.assign(process.env, testEnv(process.env));
