'use strict';
var path = require('path'),
    fs = require('fs'),
    url = require('url'),
    async = require('async'),
    raml = require('raml-parser'),
    _ = require('lodash'),
    schemaMocker = require('./schema.js'),
    RequestMocker = require('./requestMocker.js');

function generate(options, callback) {
    if (!callback || !_.isFunction(callback)) {
        throw new Error('`callback` is not a function');
    }
    if (options == null) {
        var err = new Error('You must define an options object');
        err.code = 'NO_OPTIONS';
        callback(err);
    }
    var formats = {};
    var parserOptions = _.defaults(_.get(options, 'parserOptions'), {dereferenceSchemas: true});
    if (options.formats) {
        formats = options.formats;
    }
    try {
        if (options.path) {
            generateFromPath(options.path, parserOptions, formats, callback);
        } else if (options.files && _.isArray(options.files)) {
            generateFromFiles(options.files, parserOptions, formats, callback);
        }
    } catch (err) {
        callback(err);
    }
}

function generateFromPath(filesPath, parserOptions, formats, callback) {
    fs.readdir(filesPath, function (err, files) {
        if (err) {
            throw err;
        }
        var filesToGenerate = [];
        _.each(files, function (file) {
            if (file.substr(-5) === '.raml') {
                filesToGenerate.push(path.join(filesPath, file));
            }
        });
        generateFromFiles(filesToGenerate, parserOptions, formats, callback);
    });
}

function generateFromFiles(files, parserOptions, formats, callback) {
    var requestsToMock = [];
    async.each(files, function (file, cb) {
        raml.loadFile(file, parserOptions)
        .then(function (data) {
            getRamlRequestsToMock(data, '/', formats, function (err, reqs) {
                if (err) return cb(err);
                requestsToMock = _.union(requestsToMock, reqs);
                cb();
            });
        })
        .catch(cb);
    }, function (err) {
        callback(err, requestsToMock);
    });
}

function getRamlRequestsToMock(definition, uri, formats, callback) {
    var requestsToMock = [];
    if (definition.relativeUri) {
        var nodeURI = definition.relativeUri;
        if (definition.uriParameters) {
            _.each(definition.uriParameters, function (uriParam, name) {
                nodeURI = nodeURI.replace('{' + name + '}', ':' + name);
            });
        }
        uri = (uri + '/' + nodeURI).replace(/\/{2,}/g, '/');
    }
    var tasks = [];
    if (definition.methods) {
        tasks.push(function (cb) {
            getRamlRequestsToMockMethods(definition, uri, formats, function (err, reqs) {
                if (err) return cb(err);
                requestsToMock = _.union(requestsToMock, reqs);
                cb();
            });
        });
    }
    if (definition.resources) {
        tasks.push(function (cb) {
            getRamlRequestsToMockResources(definition, uri, formats, function (err, reqs) {
                if (err) return cb(err);
                requestsToMock = _.union(requestsToMock, reqs);
                cb();
            });
        });
    }
    async.parallel(tasks, function (err) {
        callback(err, requestsToMock);
    });
}

function getRamlRequestsToMockMethods(definition, uri, formats, callback) {
    var responsesByCode = [];
    try { // JSON.parse in getResponsesByCode may fail
        _.each(definition.methods, function (method) {
            if (method.method && /get|post|put|delete/i.test(method.method) && method.responses) {
                var responsesMethodByCode = getResponsesByCode(method.responses);

                var methodMocker = new RequestMocker(uri, method.method);

                var currentMockDefaultCode = null;
                _.each(responsesMethodByCode, function (reqDefinition) {
                    methodMocker.addResponse(reqDefinition.code, function () {
                        if (reqDefinition.schema) {
                            return schemaMocker(reqDefinition.schema, formats);
                        } else {
                            return null;
                        }
                    }, function () {
                        return reqDefinition.example;
                    });
                    if ((!currentMockDefaultCode || currentMockDefaultCode > reqDefinition.code) && /^2\d\d$/.test(reqDefinition.code)) {
                        methodMocker.mock = methodMocker.getResponses()[reqDefinition.code];
                        methodMocker.example = methodMocker.getExamples()[reqDefinition.code];
                        currentMockDefaultCode = reqDefinition.code;
                    }
                });
                if (currentMockDefaultCode) {
                    methodMocker.defaultCode = currentMockDefaultCode;
                }
                responsesByCode.push(methodMocker);
            }
        });
    } catch (err) {
        return callback(err);
    }
    callback(null, responsesByCode);
}

function getResponsesByCode(responses) {
    var responsesByCode = [];
    _.each(responses, function (response, code) {
        if (!response) return;
        var body = response.body && response.body['application/json'];
        // it validates any possible media vendor type
        for (var key in response.body) {
            if (response.body.hasOwnProperty(key) && key.match(/application\/[A-Za-z.-0-1]*\+?(json|xml)/)) {
                body = response.body[key];
                break;
            }
        }
        var schema = null;
        var example = null;
        if (!_.isNaN(Number(code)) && body) {
            code = Number(code);
            example = body.example;
            schema = body.schema && JSON.parse(body.schema);
            responsesByCode.push({
                code: code,
                schema: schema,
                example: example
            });
        }
    });
    return responsesByCode;
}

function getRamlRequestsToMockResources(definition, uri, formats, callback) {
    var requestsToMock = [];
    var baseUri = '';

    if (definition.baseUri && definition.baseUriParameters) {
      // extra the variables from the baseUri
      var uriElems = definition.baseUri.match(/{[a-zA-Z]+}/g);

      // get the default variable value from the baseUriParameters
      var tempBaseUri = definition.baseUri;
      uriElems.map(function (elem) { // e.g. elem == '{host}'
        var strippedElem = elem.replace("{","").replace("}","");
        var elemValue = definition.baseUriParameters[strippedElem].default;
        if (!elemValue) {
          // if not available, look into definition for a value
          elemValue = definition[strippedElem];
        }
        if (elemValue) {
          tempBaseUri = tempBaseUri.replace( new RegExp(elem, 'g'), elemValue);
        } else {
          console.log("No value found for "+elem);
        }
      });
      baseUri = url.parse(tempBaseUri).pathname;
    }

    if (definition.baseUri && !definition.baseUriParameters) {
        baseUri = url.parse(definition.baseUri).pathname;
    }

    async.each(definition.resources, function (def, cb) {
        getRamlRequestsToMock(def, baseUri + uri, formats, function (err, reqs) {
            if (err) return cb(err);
            requestsToMock = _.union(requestsToMock, reqs);
            cb();
        });
    }, function (err) {
        callback(err, requestsToMock);
    });
}
module.exports = {
    generate: generate
};
