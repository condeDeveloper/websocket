/**
 * O cliente.
 *
 * Existe por dois motivos. O primeiro é que sem ele não dá para testar o
 * servidor sem depender de uma biblioteca de fora. O segundo é que o lado do
 * cliente tem uma responsabilidade que o servidor não tem — **mascarar todo
 * quadro** — e ver os dois lados juntos é o que faz a regra parar de parecer
 * arbitrária.
 */

import { connect as conectarTcp } from 'node:net';
import { connect as conectarTls } from 'node:tls';

import { VERSAO, chaveNova, respostaPara } from './aperto.js';
import { Conexao } from './conexao.js';

/** O aperto de mão do cliente falhou. */
export class ErroDeConexao extends Error {
  constructor(mensagem, status = null) {
    super(mensagem);
    this.name = 'ErroDeConexao';
    this.status = status;
  }
}

/** Separa a URL em destino, caminho e se é seguro. */
export function lerEndereco(endereco) {
  const url = new URL(endereco);

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new ErroDeConexao(`Protocolo inesperado: ${url.protocol}. Use ws:// ou wss://.`);
  }

  const seguro = url.protocol === 'wss:';

  return {
    seguro,
    maquina: url.hostname,
    porta: Number(url.port) || (seguro ? 443 : 80),
    caminho: `${url.pathname || '/'}${url.search}`,
    anfitriao: url.host,
  };
}

/** Monta o GET que pede o upgrade. */
export function pedidoDeUpgrade({ caminho, anfitriao, chave, protocolos = [], cabecalhos = {} }) {
  const linhas = [
    `GET ${caminho} HTTP/1.1`,
    `Host: ${anfitriao}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${chave}`,
    `Sec-WebSocket-Version: ${VERSAO}`,
  ];

  if (protocolos.length > 0) linhas.push(`Sec-WebSocket-Protocol: ${protocolos.join(', ')}`);

  for (const [nome, valor] of Object.entries(cabecalhos)) linhas.push(`${nome}: ${valor}`);

  return `${linhas.join('\r\n')}\r\n\r\n`;
}

/** Lê a resposta do servidor até o fim dos cabeçalhos. */
export function lerResposta(texto) {
  const [inicial, ...resto] = texto.split('\r\n');
  const status = Number(inicial.split(' ')[1]);
  const cabecalhos = Object.create(null);

  for (const linha of resto) {
    const corte = linha.indexOf(':');

    if (corte > 0) cabecalhos[linha.slice(0, corte).trim().toLowerCase()] = linha.slice(corte + 1).trim();
  }

  return { status, cabecalhos };
}

/**
 * Abre uma conexão.
 *
 * @param {string} endereco `ws://...` ou `wss://...`
 * @returns {Promise<Conexao>}
 */
export function conectar(endereco, { protocolos = [], cabecalhos = {}, prazo = 10_000 } = {}) {
  const alvo = lerEndereco(endereco);
  const chave = chaveNova();

  return new Promise((cumprir, rejeitar) => {
    const soquete = alvo.seguro
      ? conectarTls({ host: alvo.maquina, port: alvo.porta, servername: alvo.maquina })
      : conectarTcp({ host: alvo.maquina, port: alvo.porta });

    let acumulado = Buffer.alloc(0);
    let resolvido = false;

    const relogio = setTimeout(() => {
      if (resolvido) return;

      resolvido = true;
      soquete.destroy();
      rejeitar(new ErroDeConexao(`O aperto de mão passou de ${prazo} ms.`));
    }, prazo);

    const desistir = (erro) => {
      if (resolvido) return;

      resolvido = true;
      clearTimeout(relogio);
      soquete.destroy();
      rejeitar(erro);
    };

    soquete.on('error', desistir);
    soquete.on('close', () => desistir(new ErroDeConexao('O servidor fechou durante o aperto de mão.')));

    soquete.on('connect', () => {
      soquete.setNoDelay(true);
      soquete.write(pedidoDeUpgrade({ ...alvo, chave, protocolos, cabecalhos }));
    });

    if (alvo.seguro) soquete.on('secureConnect', () => soquete.setNoDelay(true));

    const aoReceber = (pedaco) => {
      acumulado = Buffer.concat([acumulado, pedaco]);

      const fim = acumulado.indexOf('\r\n\r\n');

      // Ainda não chegaram todos os cabeçalhos.
      if (fim < 0) return;

      const { status, cabecalhos: recebidos } = lerResposta(acumulado.subarray(0, fim).toString('utf8'));

      if (status !== 101) {
        desistir(new ErroDeConexao(`O servidor respondeu ${status} em vez de 101.`, status));
        return;
      }

      // Sem conferir isto, qualquer coisa que responda 101 passaria por
      // WebSocket — inclusive um cache devolvendo uma resposta guardada.
      if (recebidos['sec-websocket-accept'] !== respostaPara(chave)) {
        desistir(new ErroDeConexao('O Sec-WebSocket-Accept não corresponde à chave enviada.'));
        return;
      }

      resolvido = true;
      clearTimeout(relogio);

      soquete.off('data', aoReceber);
      soquete.off('close', desistir);
      soquete.off('error', desistir);

      const conexao = new Conexao(soquete, { ehCliente: true });

      conexao.protocolo = recebidos['sec-websocket-protocol'] ?? null;

      // Sobrou byte depois do cabeçalho: é quadro que o servidor já mandou.
      const sobra = acumulado.subarray(fim + 4);

      if (sobra.length > 0) conexao.receber(sobra);

      cumprir(conexao);
    };

    soquete.on('data', aoReceber);
  });
}

/** Espera a próxima mensagem — útil em teste e em script curto. */
export function proximaMensagem(conexao, { prazo = 5000 } = {}) {
  return new Promise((cumprir, rejeitar) => {
    const relogio = setTimeout(() => {
      conexao.off('mensagem', aoChegar);
      rejeitar(new Error(`Nenhuma mensagem em ${prazo} ms.`));
    }, prazo);

    const aoChegar = (mensagem) => {
      clearTimeout(relogio);
      cumprir(mensagem);
    };

    conexao.once('mensagem', aoChegar);
  });
}
