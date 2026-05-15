import { Sequelize } from 'sequelize';
import { DEFAULT_SQLITE_FILE } from '../lib/paths.js';

const sequelizeOptions = {
    dialect: 'sqlite',
    logging: false,
    storage: process.env.DB_STORAGE || DEFAULT_SQLITE_FILE,
    pool: {
        max: 1
    }
};

const sequelize = new Sequelize(sequelizeOptions);

export { sequelize };
