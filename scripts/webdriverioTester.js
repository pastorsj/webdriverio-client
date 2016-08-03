#! /usr/bin/env node

/**
 * @author Adam Meadows [@job13er](https://github.com/job13er)
 * @copyright 2015 Ciena Corporation. All rights reserved
 */

'use strict'

/**
 * @typedef Result
 * @property {Number} code - the exit code of the command
 * @property {String} stdout - the standard output from command
 */

const _ = require('lodash')
const Q = require('q')
const path = require('path')
const fs = require('fs-extra')
const exec = require('child_process').exec
const sleep = require('sleep')
const argv = require('minimist')(process.argv.slice(2), {
  'boolean': 'app'
})
const TOKEN_REVOKED = '~'
const TRAVIS_USERNAME = 'travis'
const WEB_FLOW_USERNAME = 'web-flow'

const GitHubAPI = require('github')

/**
 * Helper for creating a promise (so I don't need to disable new-cap everywhere)
 * @param {*} resolution - what to resolve the promise with
 * @returns {Promise} the promise
 */
function makePromise (resolution) {
  return Q(resolution) // eslint-disable-line new-cap
}

/** @alias tester */
const ns = {
  /**
   * Initialize the module
   * @returns {tester} the tester instance
   */
  init () {
    // this is on the object for eaiser mocking
    this.exec = Q.denodeify(exec)
    this.github = new GitHubAPI({
      debug: false,
      protocol: 'https',
      host: 'api.github.com',
      timeout: 5000
    })
    return this
  },

  /**
   * obvious
   * @param {String} filename - the filename to remove
   * @returns {Promise} resolved with result of exec
   */
  remove (filename) {
    return this.exec('rm -rf ' + filename)
  },

  copyIntoAllDirectories (file, testsDir, directories) {
    if (file === 'jasmine.json') {
      directories.forEach((dir) => {
        let jasmineFile = {}
        jasmineFile['spec_dir'] = dir
        jasmineFile['spec_files'] = ['*-spec.js']
        fs.writeFileSync(path.join(testsDir, 'tmp', dir, file), JSON.stringify(jasmineFile, null, 2))
      })
    } else {
      directories.forEach((dir) => {
        fs.copySync(path.join(testsDir, file), path.join(testsDir, 'tmp', dir, file))
      })
    }
  },

  createTmpDirectory () {
    const testsDir = path.join(__dirname, '../../..', 'tests', 'e2e')
    // Recreate tmp directory
    let tmpDir = path.join(testsDir, 'tmp')
    fs.emptyDirSync(tmpDir)
    let files = fs.readdirSync(testsDir)
    let newDirectories = []
    files.forEach((file) => {
      if (file.endsWith('e2e.js')) {
        const fname = file.slice(0, -3)
        newDirectories.push(fname)
        fs.ensureDirSync(path.join(tmpDir, fname))
        fs.copySync(path.join(testsDir, file), path.join(tmpDir, fname, file))
      }
    })
    let movedConfig = false
    files.forEach((file) => {
      if (file === 'jasmine.json' || file === 'aaa-spec.js' || file === 'test-config.json') {
        this.copyIntoAllDirectories(file, testsDir, newDirectories)
      } else if (!file.endsWith('e2e.js') && file.endsWith('.js')) {
        this.copyIntoAllDirectories(file, testsDir, newDirectories)
      } else if (file === 'config.json' && !movedConfig) {
        fs.copySync(path.join(testsDir, file), path.join(testsDir, 'tmp', file))
        movedConfig = true
      }
    })
  },

  /**
   * obvious
   * @param {String[]} extras - extra files/directories to include in tarball
   * @returns {Promise} resolved when done
   */
  tarUpAppAndTestsDirectory (extras) {
    this.createTmpDirectory()
    let cmd = ['tar', '--exclude="*.map"', '-czf', 'test.tar.gz',
               process.env['E2E_TESTS_DIR'], process.env['BUILD_OUTPUT_DIR']]
    cmd = cmd.concat(extras)

    return this.exec(cmd.join(' '))
  },

  /**
   * Create a tarball of the resources to submit
   * @param {Boolean} isApp - true if we need to fake the demo directory
   * @param {String[]} extras - optional extra files/directories to include in tarball
   * @returns {Promise} resolved when done
   */
  createTarball (isApp, extras) {
    return this.tarUpAppAndTestsDirectory(extras)
  },

  /**
   * Finds the username of developer using the Travis commit number and the GitHub API
   * @param {Object} configFile - Contains the username and token of the developer
   * @returns {Promise} Either resolves with an updated version of the config file or rejects with an error
   */
  findUsername (configFile) {
    return new Promise((resolve, reject) => {
      console.log(`Your config.json file must contain a valid username and token.
      Please visit http://wdio.bp.cyaninc.com to sign up to become an authorized third party developer for Ciena. \n\n`)
      let repo = process.env['TRAVIS_REPO_SLUG'].split('/')
      let user = repo[0]
      let sha = process.env['TRAVIS_COMMIT']
      repo = repo[1]
      this.github.authenticate({
        type: 'oauth',
        token: process.env['RO_GH_TOKEN']
      })
      this.github.repos.getCommit({
        user,
        repo,
        sha
      }, (err, res) => {
        if (err) {
          console.log('Error 4: ' + err)
          reject(err)
        } else {
          let author = res.committer.login
          if (author === WEB_FLOW_USERNAME && res.author.login) {
            author = res.author.login
          }
          configFile.username = author
          console.log('Author ' + configFile)
          resolve(configFile)
        }
      })
    })
  },

  /**
   * Extracts the config.json file from the tests/e2e directory. If it does not exist, it assumes it on TravisCI, and it attempts
   * to extract the appropriate environment variables
   * @returns {Promise} It will either resolve with the configFile or reject with an error
   */
  extractConfig () {
    return new Promise((resolve, reject) => {
      const configDir = path.join(__dirname, '../../..', process.env['E2E_TESTS_DIR'], 'config.json')
      let configFile = {}
      try {
        configFile = JSON.parse(fs.readFileSync(configDir))
      } catch (e) {
        console.log(`Since a config.json file does not exist, we are assuming you are on Travis\n\n`)
      }
      _.defaults(configFile, {username: TRAVIS_USERNAME, token: TOKEN_REVOKED})
      if (configFile.username === TRAVIS_USERNAME) {
        this.findUsername(configFile).then((result) => {
          resolve(result)
        })
        .catch((err) => {
          reject(err)
        })
      } else {
        resolve(configFile)
      }
    })
  },

  /**
   * Submit the tarball for test
   * @param {String} server - the protocol/host/port of the server
   * @returns {Promise} resolved when done
   */
  submitTarball (server) {
    console.log('Submitting bundle to ' + server + ' for test...')
    return this.extractConfig()
    .then((configFile) => {
      const cmd = [
        'curl',
        '-s',
        '-H',
        '"username: ' + configFile.username + '"',
        '-H',
        '"token: ' + configFile.token + '"',
        '-F',
        '"tarball=@test.tar.gz"',
        '-F',
        '"entry-point=' + process.env['BUILD_OUTPUT_DIR'] + '/"',
        '-F',
        '"tests-folder=' + process.env['E2E_TESTS_DIR'] + '"',
        server + '/'
      ]
      if (server.startsWith('localhost')) {
        cmd.splice(2, 0, '-H')
        cmd.splice(3, 0, '"x-forwarded-for: 127.0.0.1"')
      }
      console.log('Running command: ' + cmd.join(' '))

      return this.exec(cmd.join(' '))
      .then((res) => {
        const timestamp = res[0]
        this.exec()
        if (isNaN(timestamp)) {
          throw new Error('The server responded with: ' + timestamp)
        }
        console.log('Server Response/Timestamp: ' + timestamp)
        return timestamp
      })
      .catch((err) => {
        throw new Error(err)
      })
    })
    .catch((err) => {
      throw new Error(err)
    })
  },

  /**
   * Wait till the server is done with our tests
   * @param {String} cmd - the command to execute to check for results
   * @param {Number} pollInterval - the poll interval in seconds
   * @returns {Promise} resolved when done
   */
  checkForResults (cmd, pollInterval) {
    console.log('Checking for results...')
    return this.exec(cmd).then((res) => {
      const stdout = res[0]
      if (stdout.toString().toLowerCase() === 'not found') {
        sleep.sleep(pollInterval)
        return this.checkForResults(cmd, pollInterval)
      } else {
        return makePromise()
      }
    })
  },

  /**
   * Wait till the server is done with our tests
   * @param {Object} params - object for named parameters
   * @param {String} params.timestamp - the timestamp of the results we're waiting for
   * @param {String} params.server - the protocol/host/port of the server
   * @param {Number} params.initialSleep - the initial sleep time in seconds
   * @param {Number} params.pollInterval - the poll interval in seconds
   * @returns {Promise} resolved when done
   */
  waitForResults (params) {
    console.log('Waiting ' + params.initialSleep + 's before checking')
    sleep.sleep(params.initialSleep)

    const cmd = 'curl -s ' + params.server + '/status/' + params.timestamp
    return this.checkForResults(cmd, params.pollInterval)
  },

  /**
   * Fetch the results from the server
   * @param {String} url - the url to fetch results from
   * @returns {Promise} resolved when done
   */
  getResults (url) {
    return this.exec('curl -s ' + url).then((res) => {
      const stdout = res[0]
      console.log('Parsing results...')
      const obj = JSON.parse(stdout.toString())
      return obj
    })
  },

  /**
   * obvious
   * @param {String} url - the URL to get the tarball from
   * @returns {Promise} resolved when done
   */
  getTarball (url) {
    return this.exec('curl -s -O ' + url)
  },

  /**
   * Obvious
   * @param {WebdriverioServerTestResults} results - details of the test results
   * @returns {Promise} resolved when done
   */
  extractTarball (results) {
    const filename = path.basename(results.output)
    return this.exec('tar -xf ' + filename).then(() => {
      return {
        filename: filename,
        results: results
      }
    })
  },

  /**
   * Parse and output the results
   * @param {String} timestamp - the timestamp of the results we're processing
   * @param {String} server - the protocol/host/port of the server
   * @returns {Promise} resolved when done
   */
  processResults (timestamp, server) {
    const url = server + '/screenshots/output-' + timestamp + '.json'

    return this.getResults(url)
      .then((results) => {
        const url = server + '/' + results.output
        return this.getTarball(url).then(() => {
          return results
        })
      })
      .then((results) => {
        return this.extractTarball(results)
      })
      .then((params) => {
        return this.remove(params.filename).then(() => {
          return params.results
        })
      })
      .then((results) => {
        console.log(results.info)

        console.log('----------------------------------------------------------------------')
        console.log('Screenshots directory updated with results from server.')

        if (results.exitCode === 0) {
          console.log('Tests Pass.')
        } else {
          console.log('Tests FAILED')
          process.exit(1)
        }
      })
      .catch((err) => {
        throw new Error('Error processing results ' + err)
      })
  },

  /**
   * Actual functionality of the 'webdriverio-test' command
   * @param {MinimistArgv} argv - the minimist arguments object
   * @throws CliError
   */
  command (argv) {
    _.defaults(argv, {
      initialSleep: 10,
      pollInterval: 3,
      server: 'http://localhost:3000'
    })

    const extras = argv._.slice(1)
    console.log('isApp is :' + argv.app)

    this.createTarball(argv.app, extras)
      .then(() => {
        return this.submitTarball(argv.server)
      })
      .then((timestamp) => {
        return this.remove('test.tar.gz').then(() => {
          return timestamp
        })
      })
      .then((timestamp) => {
        const params = {
          timestamp: timestamp,
          server: argv.server,
          pollInterval: argv.pollInterval,
          initialSleep: argv.initialSleep
        }

        return this.waitForResults(params).then(() => {
          return timestamp
        })
      })
      .then((timestamp) => {
        return this.processResults(timestamp, argv.server)
      })
      .done()
  }
}

function factory () {
  return Object.create(ns).init()
}

factory.proto = ns

factory().command(argv)
