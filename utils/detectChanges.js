const detectChanges = (oldData = {}, newData = {}) => {
    const changes = {};

    for (const key of Object.keys(newData)) {
        if (oldData[key] !== newData[key]) {
            changes[key] = {
                old: oldData[key] ?? null,
                new: newData[key]
            };
        }
    }

    return changes;
};

module.exports = detectChanges;
