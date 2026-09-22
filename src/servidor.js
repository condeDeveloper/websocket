/**
 * O servidor.
 *
 * Um servidor WebSocket é um servidor HTTP comum que escuta o evento
 * `upgrade`. Quem chega pedindo upgrade sai do mundo HTTP; o resto continua
 * sendo atendido normalmente. É por isso que dá para servir a página e o
 * WebSocket dela na mesma porta.
 */

import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';

import { ErroDeAperto, conferirPedido, escolherProtocolo, resposta101, respostaDeRecusa } from './aperto.js';
import { Conexao } from './conexao.js';
import { FECHAMENTO } from './quadro.js';

/** Um servidor WebSocket. Emite `conexao`, `recusa` e `erro`. */
export class ServidorWebSocket extends EventEmitter {
  /**
   * @param {{
   *   servidor?: import('node:http').Server,
   *   caminho?: string | null,
   *   protocolos?: string[],
   *   verificar?: (requisicao) => boolean | Promise<boolean>,
   *   batimento?: number,
   *   maximoDeMensagem?: number,
   * }} opcoes
   */
  constructor({
    servidor = null,
    caminho = null,
    protocolos = [],
    verificar = null,
    batimento = 0,
    maximoDeMensagem = 16 * 1024 * 1024,
  } = {}) {
    super();

    this.http = servidor ?? createServer((_requisicao, resposta) => {
      resposta.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
      resposta.end('Esta porta só atende WebSocket.\n');
    });

    this.proprio = servidor === null;
    this.caminho = caminho;
    this.protocolos = protocolos;
    this.verificar = verificar;
    this.batimento = batimento;
    this.maximoDeMensagem = maximoDeMensagem;

    /** @type {Set<Conexao>} */
    this.conexoes = new Set();
    this.relogio = null;

    this.http.on('upgrade', (requisicao, soquete, cabeca) => {
      this.aoSubir(requisicao, soquete, cabeca).catch((erro) => this.emit('erro', erro));
    });
  }

  /** Começa a escutar. */
  async escutar(porta = 0, endereco = '127.0.0.1') {
    await new Promise((cumprir, rejeitar) => {
      this.http.once('error', rejeitar);
      this.http.listen(porta, endereco, () => {
        this.http.off('error', rejeitar);
        cumprir();
      });
    });

    if (this.batimento > 0) this.comecarBatimento();

    return this.http.address();
  }

  /** A porta em que o servidor está, depois de escutar. */
  get porta() {
    return this.http.address()?.port ?? null;
  }

  /** Trata um pedido de upgrade. */
  async aoSubir(requisicao, soquete, cabeca) {
    try {
      if (this.caminho !== null && new URL(requisicao.url, 'http://local').pathname !== this.caminho) {
        throw new ErroDeAperto(`Nada escuta em ${requisicao.url}.`, 404);
      }

      const { chave, protocolos } = conferirPedido(requisicao);

      if (this.verificar && !(await this.verificar(requisicao))) {
        throw new ErroDeAperto('Recusado pela verificação do servidor.', 403);
      }

      const protocolo = escolherProtocolo(protocolos, this.protocolos);

      // Quando o servidor exige subprotocolo e o cliente não oferece nenhum
      // compatível, seguir em frente só adiaria o desentendimento.
      if (this.protocolos.length > 0 && protocolo === null) {
        throw new ErroDeAperto(`Nenhum subprotocolo em comum. Aceito: ${this.protocolos.join(', ')}.`);
      }

      // Sem isso, o Nagle junta quadros pequenos e acrescenta dezenas de
      // milissegundos justo no caso de uso que pede WebSocket.
      soquete.setNoDelay(true);
      soquete.write(resposta101(chave, { protocolo }));

      const conexao = new Conexao(soquete, { maximoDeMensagem: this.maximoDeMensagem });

      conexao.protocolo = protocolo;
      conexao.vivo = true;

      conexao.on('pong', () => {
        conexao.vivo = true;
      });

      conexao.on('fechada', () => this.conexoes.delete(conexao));
      conexao.on('erro', (erro) => this.emit('erro', erro));

      this.conexoes.add(conexao);
      this.emit('conexao', conexao, requisicao);

      // O `upgrade` pode trazer bytes que já chegaram junto com o pedido.
      // Jogá-los fora perderia a primeira mensagem de um cliente apressado.
      if (cabeca && cabeca.length > 0) conexao.receber(cabeca);
    } catch (erro) {
      this.emit('recusa', erro, requisicao);

      if (soquete.writable) soquete.write(respostaDeRecusa(erro));

      soquete.destroy();
    }
  }

  /**
   * Manda a mesma mensagem para todo mundo.
   *
   * @param {*} dados
   * @param {Conexao|null} menos conexão a pular (normalmente quem enviou)
   */
  transmitir(dados, menos = null) {
    let enviadas = 0;

    for (const conexao of this.conexoes) {
      if (conexao === menos || !conexao.aberta) continue;

      conexao.enviar(dados);
      enviadas += 1;
    }

    return enviadas;
  }

  /**
   * Liga o ping periódico.
   *
   * Sem ele, uma conexão cortada por NAT ou por proxy fica "aberta" dos dois
   * lados até alguém tentar escrever — o que pode demorar horas. O ping é o
   * que transforma isso em segundos.
   */
  comecarBatimento() {
    this.relogio = setInterval(() => {
      for (const conexao of this.conexoes) {
        if (!conexao.vivo) {
          conexao.soquete.destroy();
          continue;
        }

        conexao.vivo = false;
        conexao.ping();
      }
    }, this.batimento);

    this.relogio.unref?.();

    return this.relogio;
  }

  /** Fecha tudo: as conexões primeiro, o servidor depois. */
  async fechar({ codigo = FECHAMENTO.saindo, motivo = 'servidor encerrando' } = {}) {
    if (this.relogio) clearInterval(this.relogio);

    for (const conexao of [...this.conexoes]) {
      conexao.fechar(codigo, motivo, { prazo: 200 });
      conexao.soquete.destroy();
    }

    this.conexoes.clear();

    if (!this.proprio) return;

    await new Promise((cumprir) => this.http.close(() => cumprir()));
  }
}

/** Atalho: cria e já põe para escutar. */
export async function servir(opcoes = {}) {
  const servidor = new ServidorWebSocket(opcoes);

  await servidor.escutar(opcoes.porta ?? 0, opcoes.endereco ?? '127.0.0.1');

  return servidor;
}
