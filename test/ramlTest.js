'use strict';
var _ = require('lodash');
var ramlMocker = require('../src/index.js');
// ramlMocker.generate();
ramlMocker.generate({
    path: 'test/raml',
    formats: {
        Bar: function foo(Faker, schema) {
            return 'BAR';
        }
    }
}, function (err, methods) {
    if (err) return console.log(err.stack || err);
    console.log(methods);
    _.each(methods, function (m) {
        var mock = m.mock();
        if (mock) {
            console.log(mock);
        }
        var example = m.example();
        if (example) {
            console.log(example);
        }
    });
});
