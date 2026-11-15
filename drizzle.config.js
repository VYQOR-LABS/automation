import { config } from './src/config.js';
export default {
    schema: './src/db/schema.ts',
    out: './drizzle',
    dialect: 'postgresql',
    dbCredentials: {
        url: config.databaseUrl,
    },
    verbose: true,
    strict: true,
};
//# sourceMappingURL=drizzle.config.js.map