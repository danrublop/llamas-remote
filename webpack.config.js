const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  mode: 'development',
  entry: {
    panel: './src/renderer/panel.tsx',
    notebook: './src/renderer/notebook.tsx'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js'
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js', '.jsx']
  },
  module: {
    rules: [
      // Excalidraw's dep `roughjs` ships ESM with extensionless imports (roughjs/bin/generator);
      // webpack 5 treats node_modules ESM as fully-specified and errors. Relax that here.
      { test: /\.m?js$/, resolve: { fullySpecified: false } },
      {
        test: /\.tsx?$/,
        use: {
          loader: 'ts-loader',
          options: {
            configFile: 'tsconfig.renderer.json'
          }
        },
        exclude: /node_modules/
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      },
      {
        test: /\.(png|jpg|jpeg|gif|svg)$/i,
        type: 'asset/resource'
      }
    ]
  },
  plugins: [
    // dev needs 'unsafe-eval' for the eval-cheap-module-source-map devtool below.
    new HtmlWebpackPlugin({
      template: './src/renderer/panel.html',
      filename: 'panel.html',
      chunks: ['panel'],
      templateParameters: { cspScriptSrc: "'self' 'unsafe-eval'" }
    }),
    new HtmlWebpackPlugin({
      template: './src/renderer/notebook.html',
      filename: 'notebook.html',
      chunks: ['notebook'],
      templateParameters: { cspScriptSrc: "'self' 'unsafe-eval'" }
    }),
  ],
  // Dev-only config (prod packaging uses webpack.prod.config.js). Full 'source-map' emits
  // multi-MB external maps and made dev builds take minutes; eval-cheap keeps rebuilds ~3s.
  // Needs 'unsafe-eval' in the dev CSP (already allowed in panel.html/notebook.html).
  devtool: 'eval-cheap-module-source-map',
  // Enable hot reloading
  devServer: {
    hot: true,
    liveReload: true,
    watchFiles: ['src/renderer/**/*'],
    static: {
      directory: path.join(__dirname, 'dist'),
    },
    compress: true,
    port: 3000,
  },
  // NOTE: no top-level `watch: true` here — it made every one-shot `webpack` / `npm run build`
  // hang forever (compile, then sit watching, never exit). The `watch:renderer` script passes
  // `--watch` explicitly when a watcher is actually wanted.
  watchOptions: {
    ignored: /node_modules/,
    aggregateTimeout: 300,
    poll: 1000,
  }
};
