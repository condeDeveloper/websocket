/**
 * A conexão: a máquina de estados em cima do soquete.
 *
 * Aqui moram as três coisas que fazem um WebSocket funcionar de verdade
 * depois que o aperto de mão passou:
 *
 * - **Remontagem.** TCP entrega bytes, não mensagens. Um `data` pode trazer
 *   meio cabeçalho, e dois quadros podem chegar no mesmo. Sem um buffer
 *   acumulador, funciona nos testes locais e quebra na primeira rede real.
 * - **Fragmentação.** Uma mensagem grande vem em pedaços, e quadros de
 *   controle podem aparecer **no meio** deles. Um ping precisa ser respondido
 *   mesmo enquanto um arquivo de 10 MB está chegando.
 * - **Fechamento em duas vias.** Quem fecha manda um quadro e espera o eco.
 *   Fechar o soquete na hora descarta o que já estava a caminho.
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

import {
  ErroDeProtocolo,
  FECHAMENTO,
  OPCODES,
  cargaDeFechamento,
  ehControle,
  lerFechamento,
  lerQuadro,
  montarQuadro,
} from './quadro.js';

/** Decodificador estrito: texto inválido tem que ser recusado, não remendado. */
const DECODIFICADOR = new TextDecoder('utf-8', { fatal: true });

/** Os estados possíveis. */
export const ESTADOS = ['aberta', 'fechando', 'fechada'];

/**
 * Uma conexão WebSocket já estabelecida.
 *
 * Eventos: `mensagem` ({tipo, dados}), `ping`, `pong`, `fechando`,
 * `fechada` ({codigo, motivo}) e `erro`.
 */
export class Conexao extends EventEmitter {
  /**
   * @param {import('node:net').Socket} soquete
   * @param {{ehCliente?: boolean, maximoDeMensagem?: number, maximoDeQuadro?: number}} opcoes
   */
  constructor(soquete, { ehCliente = false, maximoDeMensagem = 16 * 1024 * 1024, maximoDeQuadro = 16 * 1024 * 1024 } = {}) {
    super();

    this.soquete = soquete;
    this.ehCliente = ehCliente;
    this.maximoDeMensagem = maximoDeMensagem;
    this.maximoDeQuadro = maximoDeQuadro;
    this.estado = 'aberta';

    this.acumulado = Buffer.alloc(0);
    this.pedacos = [];
    this.tipoDaMensagem = null;
    this.tamanhoParcial = 0;
    this.fechamento = null;

    soquete.on('data', (dados) => this.receber(dados));
    soquete.on('error', (erro) => this.emit('erro', erro));
    soquete.on('close', () => this.encerrar(this.fechamento ?? { codigo: FECHAMENTO.quedaAnormal, motivo: '' }));
  }

  /** A conexão ainda aceita mensagens da aplicação? */
  get aberta() {
    return this.estado === 'aberta';
  }

  // ------------------------------------------------------------------ entrada

  /** Recebe bytes crus do soquete. */
  receber(dados) {
    this.acumulado = this.acumulado.length === 0 ? dados : Buffer.concat([this.acumulado, dados]);

    try {
      for (;;) {
        const lido = lerQuadro(this.acumulado, { maximo: this.maximoDeQuadro });

        // `null` é o caso comum: ainda falta byte para fechar este quadro.
        if (lido === null) break;

        this.acumulado = this.acumulado.subarray(lido.consumido);
        this.tratarQuadro(lido.quadro);

        if (this.estado === 'fechada') break;
      }
    } catch (erro) {
      this.reagirAErro(erro);
    }
  }

  /** Decide o que fazer com um quadro já lido. */
  tratarQuadro(quadro) {
    // O cliente tem que mascarar e o servidor não pode. Aceitar o contrário
    // seria abrir justamente o buraco que a máscara existe para fechar.
    if (!this.ehCliente && !quadro.mascarado) {
      throw new ErroDeProtocolo('Quadro do cliente sem máscara.');
    }

    if (this.ehCliente && quadro.mascarado) {
      throw new ErroDeProtocolo('O servidor não pode mascarar.');
    }

    if (ehControle(quadro.opcode)) {
      this.tratarControle(quadro);
      return;
    }

    if (quadro.opcode === OPCODES.continuacao) {
      if (this.tipoDaMensagem === null) throw new ErroDeProtocolo('Continuação sem mensagem começada.');
    } else {
      if (this.tipoDaMensagem !== null) throw new ErroDeProtocolo('Mensagem nova antes de a anterior terminar.');

      this.tipoDaMensagem = quadro.opcode === OPCODES.texto ? 'texto' : 'binario';
    }

    this.tamanhoParcial += quadro.carga.length;

    if (this.tamanhoParcial > this.maximoDeMensagem) {
      throw new ErroDeProtocolo(`Mensagem passa do limite de ${this.maximoDeMensagem} bytes.`, FECHAMENTO.grandeDemais);
    }

    this.pedacos.push(quadro.carga);

    if (!quadro.fin) return;

    const tipo = this.tipoDaMensagem;
    const inteira = this.pedacos.length === 1 ? this.pedacos[0] : Buffer.concat(this.pedacos);

    this.pedacos = [];
    this.tipoDaMensagem = null;
    this.tamanhoParcial = 0;

    if (tipo === 'binario') {
      this.emit('mensagem', { tipo, dados: inteira });
      return;
    }

    // UTF-8 inválido é erro de protocolo, não texto estranho: a RFC manda
    // fechar com 1007, e é isso que separa um servidor conforme de um que
    // entrega lixo para a aplicação.
    let texto;

    try {
      texto = DECODIFICADOR.decode(inteira);
    } catch {
      throw new ErroDeProtocolo('Mensagem de texto com UTF-8 inválido.', FECHAMENTO.dadosInvalidos);
    }

    this.emit('mensagem', { tipo, dados: texto });
  }

  /** Ping, pong e fechamento. */
  tratarControle(quadro) {
    if (quadro.opcode === OPCODES.ping) {
      this.emit('ping', quadro.carga);

      // O pong devolve a mesma carga: é assim que quem pingou reconhece a
      // resposta e mede o tempo de ida e volta.
      if (this.aberta) this.enviarQuadro({ opcode: OPCODES.pong, carga: quadro.carga });

      return;
    }

    if (quadro.opcode === OPCODES.pong) {
      this.emit('pong', quadro.carga);
      return;
    }

    const { codigo, motivo } = lerFechamento(quadro.carga);

    if (this.estado === 'fechando') {
      // Era o eco do nosso fechamento: agora sim dá para soltar o soquete.
      this.encerrar(this.fechamento ?? { codigo, motivo });
      this.soquete.end();
      return;
    }

    this.estado = 'fechando';
    this.emit('fechando', { codigo, motivo });

    const devolvido = codigo === FECHAMENTO.semCodigo ? FECHAMENTO.normal : codigo;

    this.enviarQuadro({ opcode: OPCODES.fechar, carga: cargaDeFechamento(devolvido, '') });
    this.encerrar({ codigo, motivo });
    this.soquete.end();
  }

  /** Um erro de protocolo fecha com o código certo; o resto derruba. */
  reagirAErro(erro) {
    this.emit('erro', erro);

    const codigo = erro instanceof ErroDeProtocolo ? erro.codigo : FECHAMENTO.erroInterno;

    if (this.estado === 'fechada') return;

    try {
      if (this.soquete.writable) {
        this.soquete.write(montarQuadro({
          opcode: OPCODES.fechar,
          carga: cargaDeFechamento(codigo, ''),
          chave: this.ehCliente ? randomBytes(4) : null,
        }));
      }
    } catch {
      // Soquete já caiu: não há a quem avisar.
    }

    this.encerrar({ codigo, motivo: erro.message });
    this.soquete.destroy();
  }

  // ------------------------------------------------------------------- saída

  /** Escreve um quadro, mascarando quando é o cliente que fala. */
  enviarQuadro({ fin = true, opcode, carga = Buffer.alloc(0) }) {
    if (this.estado === 'fechada' || !this.soquete.writable) return false;

    this.soquete.write(montarQuadro({ fin, opcode, carga, chave: this.ehCliente ? randomBytes(4) : null }));

    return true;
  }

  /** Manda uma mensagem. String vira texto; Buffer vira binário. */
  enviar(dados) {
    if (!this.aberta) throw new Error(`A conexão está ${this.estado}.`);

    const binario = Buffer.isBuffer(dados) || dados instanceof Uint8Array;

    return this.enviarQuadro({
      opcode: binario ? OPCODES.binario : OPCODES.texto,
      carga: binario ? Buffer.from(dados) : Buffer.from(String(dados), 'utf8'),
    });
  }

  /**
   * Manda uma mensagem partida em vários quadros.
   *
   * Serve para não segurar tudo em memória e para deixar um ping passar entre
   * os pedaços.
   */
  enviarEmPedacos(dados, tamanho = 4096) {
    if (!this.aberta) throw new Error(`A conexão está ${this.estado}.`);

    const binario = Buffer.isBuffer(dados) || dados instanceof Uint8Array;
    const corpo = binario ? Buffer.from(dados) : Buffer.from(String(dados), 'utf8');

    if (corpo.length === 0) return this.enviar(dados);

    for (let i = 0; i < corpo.length; i += tamanho) {
      const primeiro = i === 0;
      const pedaco = corpo.subarray(i, i + tamanho);

      this.enviarQuadro({
        fin: i + tamanho >= corpo.length,
        opcode: primeiro ? (binario ? OPCODES.binario : OPCODES.texto) : OPCODES.continuacao,
        carga: pedaco,
      });
    }

    return true;
  }

  /** Manda um ping. */
  ping(carga = Buffer.alloc(0)) {
    return this.enviarQuadro({ opcode: OPCODES.ping, carga: Buffer.from(carga) });
  }

  /** Manda um pong sem ter sido pingado (a RFC permite, como sinal de vida). */
  pong(carga = Buffer.alloc(0)) {
    return this.enviarQuadro({ opcode: OPCODES.pong, carga: Buffer.from(carga) });
  }

  /**
   * Começa o fechamento e espera o eco do outro lado.
   *
   * O soquete só é solto quando o eco chega ou o prazo estoura — descartar o
   * que ainda estava a caminho seria perder mensagem já enviada.
   */
  fechar(codigo = FECHAMENTO.normal, motivo = '', { prazo = 5000 } = {}) {
    if (this.estado !== 'aberta') return false;

    this.estado = 'fechando';
    this.fechamento = { codigo, motivo };

    this.enviarQuadro({ opcode: OPCODES.fechar, carga: cargaDeFechamento(codigo, motivo) });

    const relogio = setTimeout(() => {
      if (this.estado !== 'fechada') this.soquete.destroy();
    }, prazo);

    // Um temporizador pendurado segura o processo vivo sem motivo.
    relogio.unref?.();

    return true;
  }

  /** Marca como fechada e avisa uma vez só. */
  encerrar(motivo) {
    if (this.estado === 'fechada') return;

    this.estado = 'fechada';
    this.emit('fechada', motivo);
  }
}
