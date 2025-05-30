/**
 * Copyright (c) 2024 The xterm.js authors. All rights reserved.
 * @license MIT
 */

const path = require('path');

const addonName = 'ProgressAddon';
const mainFile = 'addon-progress.js';

module.exports = {
  entry: `./out/${addonName}.js`,
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.js$/,
        use: ["source-map-loader"],
        enforce: "pre",
        exclude: /node_modules/
      }
    ]
  },
  resolve: {
    modules: ['./node_modules'],
    extensions: [ '.js' ],
    alias: {
      common: path.resolve('../../out/common'),
      browser: path.resolve('../../out/browser'),
      vs: path.resolve('../../out/vs')
    }
  },
  output: {
    filename: mainFile,
    path: path.resolve('./lib'),
    library: addonName,
    libraryTarget: 'umd',
    // Force usage of globalThis instead of global / self. (This is cross-env compatible)
    globalObject: 'globalThis',
  },
  mode: 'production'
};
