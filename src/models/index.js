import { Sequelize } from 'sequelize';
const sequelizeOptions = {
    dialect: 'sqlite',
    logging: false,
    storage: process.env.DB_STORAGE || './mumble-server.sqlite',
    pool: {
        max: 1
    }
};

const sequelize = new Sequelize(sequelizeOptions);

export { Sequelize, sequelize };
