module.exports = function (sequelize, DataTypes) {
    return sequelize.define(
        'channel_info',
        {
            server_id: {
                type: DataTypes.INTEGER,
                primaryKey: true,
                autoIncrement: false
            },
            channel_id: {
                type: DataTypes.INTEGER
            },
            key: {
                type: DataTypes.INTEGER
            },
            value: {
                type: DataTypes.TEXT
            }
        },
        {
            timestamps: false,
            freezeTableName: true
        }
    );
};
